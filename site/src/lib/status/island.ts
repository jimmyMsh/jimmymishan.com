import { apiFetch, subscribeEvents } from "../api/client";
import type {
  ApiStatus,
  ContainerStatus,
  DeployRecord,
  LogEventData,
  LogLine,
  LogsResponse,
  MetricsEventData,
  SloDay,
} from "../api/types";
import { sparklinePath, uptimeBarCells } from "./charts";
import { fmtMiB, hhmmss, relTime, trafficLines } from "./format";

// SVG user-space size for the sparklines; CSS scales them to fit their panel.
const CHART_W = 300;
const CHART_H = 60;
const MAX_METRIC_POINTS = 150; // 5-min rolling window at one sample / 2s
const MAX_LATENCY_POINTS = 60; // last hour of probes, then live probe_ms
const MAX_FEED = 10;
const MAX_TRAFFIC = 15;
const RETRY_MS = 30_000; // initial-fetch failure → auto-retry
const POLL_MS = 10_000; // stream down → snapshot polling

interface FeedEntry {
  sha: string;
  status: string;
  at: number;
}

function fmtUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function pushCapped(arr: number[], value: number, cap: number): void {
  arr.push(value);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/**
 * Hydrates the static `/status` shell: first-paints from `/api/status`, then
 * streams `/api/events`. Degrades gracefully — initial-fetch failure shows
 * the error panel and retries every 30s; a downed stream falls back to 10s
 * polling. All runtime values land in text nodes; no `aria-live` anywhere
 * (numbers change silently).
 */
export function initStatusDashboard(root: HTMLElement): void {
  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`status: missing ${sel}`);
    return el;
  };

  const jsNote = q<HTMLElement>("#st-js-note");
  const errorPanel = q<HTMLElement>("#st-error");
  const pollingNote = q<HTMLElement>("#st-polling");
  const presenceEl = q<HTMLElement>("#st-presence");
  const cpuSvg = q<SVGSVGElement>("#st-cpu-svg");
  const cpuPath = q<SVGPathElement>("#st-cpu-path");
  const cpuVal = q<HTMLElement>("#st-cpu-val");
  const memSvg = q<SVGSVGElement>("#st-mem-svg");
  const memPath = q<SVGPathElement>("#st-mem-path");
  const memVal = q<HTMLElement>("#st-mem-val");
  const latSvg = q<SVGSVGElement>("#st-lat-svg");
  const latPath = q<SVGPathElement>("#st-lat-path");
  const latVal = q<HTMLElement>("#st-lat-val");
  const loadEl = q<HTMLElement>("#st-load");
  const uptimeEl = q<HTMLElement>("#st-uptime");
  const commitEl = q<HTMLElement>("#st-commit");
  const barsEl = q<HTMLElement>("#st-bars");
  const sloEl = q<HTMLElement>("#st-slo");
  const containersEl = q<HTMLElement>("#st-containers");
  const banner = q<HTMLElement>("#st-deploy-banner");
  const feedEl = q<HTMLElement>("#st-feed");
  const trafficEl = q<HTMLElement>("#st-traffic");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let cpu: number[] = [];
  let mem: number[] = [];
  let latency: number[] = [];
  const feed: FeedEntry[] = [];
  const seenDeploys = new Set<string>();
  let traffic: LogLine[] = []; // newest-first

  let unsubscribe: (() => void) | null = null;
  let retryTimer: number | undefined;
  let polling = false;

  function drawChart(
    path: SVGPathElement,
    svg: SVGSVGElement,
    series: number[],
    label: string,
  ): void {
    path.setAttribute("d", sparklinePath(series, CHART_W, CHART_H));
    svg.setAttribute("aria-label", label);
  }

  function renderCpu(current: number): void {
    const pct = Math.round(current);
    cpuVal.textContent = `${pct}%`;
    drawChart(cpuPath, cpuSvg, cpu, `CPU usage ${pct}%`);
  }

  function renderMem(used: number, total: number): void {
    memVal.textContent = `${fmtMiB(used)} / ${fmtMiB(total)}`;
    drawChart(
      memPath,
      memSvg,
      mem,
      `Memory ${fmtMiB(used)} of ${fmtMiB(total)}`,
    );
  }

  function renderLatency(): void {
    const cur = latency.at(-1);
    latVal.textContent = cur === undefined ? "no probe data" : `${cur} ms`;
    drawChart(
      latPath,
      latSvg,
      latency,
      cur === undefined ? "Request latency" : `Request latency ${cur} ms`,
    );
  }

  function renderHost(host: ApiStatus["host"]): void {
    loadEl.textContent = `${host.load1} ${host.load5} ${host.load15}`;
    uptimeEl.textContent = fmtUptime(host.uptime_s);
  }

  function renderContainers(list: readonly ContainerStatus[]): void {
    containersEl.replaceChildren();
    if (list.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "muted";
      td.textContent = "no data yet";
      tr.append(td);
      containersEl.append(tr);
      return;
    }
    for (const c of list) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = c.name;
      const status = document.createElement("td");
      status.textContent = c.up ? "up" : "down";
      status.className = c.up ? "up" : "down";
      const cpuTd = document.createElement("td");
      cpuTd.textContent = c.cpu_pct === null ? "-" : `${c.cpu_pct}%`;
      const memTd = document.createElement("td");
      memTd.textContent = c.mem_mb === null ? "-" : fmtMiB(c.mem_mb);
      tr.append(name, status, cpuTd, memTd);
      containersEl.append(tr);
    }
  }

  function renderBars(days: SloDay[]): void {
    const todayIso = new Date().toISOString().slice(0, 10);
    barsEl.replaceChildren();
    for (const cell of uptimeBarCells(days, todayIso)) {
      const span = document.createElement("span");
      span.className = `bar bar-${cell.cls}`;
      span.title = cell.day;
      barsEl.append(span);
    }
  }

  function renderSlo(slo: ApiStatus["slo"]): void {
    sloEl.textContent =
      slo === null
        ? "no SLO data yet"
        : `${slo.availability_pct}% available over ${slo.window_days}d · p50 ${slo.p50_ms} ms · p99 ${slo.p99_ms} ms`;
  }

  function setPresence(count: number): void {
    presenceEl.textContent = String(count);
  }

  function renderFeed(): void {
    feedEl.replaceChildren();
    if (feed.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "no deploys yet";
      feedEl.append(li);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const entry of feed) {
      const li = document.createElement("li");
      const sha = document.createElement("span");
      sha.className = "sha";
      sha.textContent = entry.sha;
      const status = document.createElement("span");
      // class from a build-time literal, never the raw API string
      status.className = entry.status === "ok" ? "dep-ok" : "dep-bad";
      status.textContent = entry.status;
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = relTime(entry.at, now);
      li.append(
        sha,
        document.createTextNode(" "),
        status,
        document.createTextNode(" "),
        when,
      );
      feedEl.append(li);
    }
  }

  function renderTraffic(): void {
    trafficEl.replaceChildren();
    if (traffic.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "no traffic data";
      trafficEl.append(li);
      return;
    }
    for (const line of traffic) {
      const li = document.createElement("li");
      li.className = "traffic-row";
      li.textContent = `${hhmmss(line.ts)} · ${line.status} · ${line.country} · ${line.method} · ${line.path}`;
      trafficEl.append(li);
    }
  }

  function flashBanner(entry: FeedEntry): void {
    banner.hidden = false;
    banner.textContent = `deployed ${entry.sha} · ${entry.status}`;
    if (reduced) return;
    banner.classList.remove("flash");
    void banner.offsetWidth; // restart the CSS animation on repeat deploys
    banner.classList.add("flash");
  }

  function ingestDeploy(entry: FeedEntry, flash: boolean): void {
    const key = `${entry.sha}:${entry.at}`;
    if (seenDeploys.has(key)) return;
    seenDeploys.add(key);
    feed.unshift(entry);
    if (feed.length > MAX_FEED) feed.pop();
    renderFeed();
    if (flash) flashBanner(entry);
  }

  function applySnapshot(status: ApiStatus): void {
    cpu = status.history.map((h) => h.cpu_pct).slice(-MAX_METRIC_POINTS);
    mem = status.history.map((h) => h.mem_used_mb).slice(-MAX_METRIC_POINTS);
    latency = (status.slo?.recent ?? [])
      .map((r) => r.latency_ms)
      .slice(-MAX_LATENCY_POINTS);
    renderCpu(status.host.cpu_pct);
    renderMem(status.host.mem_used_mb, status.host.mem_total_mb);
    renderLatency();
    renderHost(status.host);
    renderContainers(status.containers);
    renderBars(status.slo?.days ?? []);
    renderSlo(status.slo);
    setPresence(status.presence);
    commitEl.textContent = status.commit;
    if (status.deploy) {
      ingestDeploy(
        {
          sha: status.deploy.sha,
          status: status.deploy.status,
          at: status.deploy.at,
        },
        false,
      );
    } else {
      renderFeed();
    }
  }

  function applyMetrics(d: MetricsEventData): void {
    pushCapped(cpu, d.host.cpu_pct, MAX_METRIC_POINTS);
    pushCapped(mem, d.host.mem_used_mb, MAX_METRIC_POINTS);
    renderCpu(d.host.cpu_pct);
    renderMem(d.host.mem_used_mb, d.host.mem_total_mb);
    if (d.probe_ms !== null)
      pushCapped(latency, d.probe_ms, MAX_LATENCY_POINTS);
    renderLatency();
    renderContainers(d.containers);
  }

  function startPolling(): void {
    if (polling) return;
    polling = true;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    pollingNote.hidden = false;
    window.setInterval(() => {
      apiFetch<ApiStatus>("/api/status", { timeoutMs: 3000 })
        .then(applySnapshot)
        .catch(() => {
          /* keep the polling note and the last painted values */
        });
    }, POLL_MS);
  }

  function startStream(): void {
    unsubscribe = subscribeEvents({
      onMetrics: applyMetrics,
      onPresence: (d) => setPresence(d.count),
      onDeploy: (d: DeployRecord) =>
        ingestDeploy({ sha: d.sha, status: d.status, at: d.at }, true),
      onLog: (d: LogEventData) => {
        traffic = trafficLines(traffic, d, MAX_TRAFFIC);
        renderTraffic();
      },
      onDown: startPolling,
    });
  }

  // Independent of the status fetch below — a disabled/unreachable log tail
  // must not turn the whole dashboard into an error state, it just leaves
  // the traffic panel on its quiet empty state.
  async function loadTraffic(): Promise<void> {
    try {
      const logs = await apiFetch<LogsResponse>("/api/logs", {
        timeoutMs: 3000,
      });
      traffic = logs.lines.slice(-MAX_TRAFFIC).reverse();
    } catch {
      traffic = [];
    }
    renderTraffic();
  }

  async function loadInitial(): Promise<void> {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    void loadTraffic();
    try {
      const status = await apiFetch<ApiStatus>("/api/status", {
        timeoutMs: 3000,
      });
      errorPanel.hidden = true;
      applySnapshot(status);
      startStream();
    } catch {
      errorPanel.hidden = false;
      retryTimer = window.setTimeout(() => {
        void loadInitial();
      }, RETRY_MS);
    }
  }

  jsNote.hidden = true;
  void loadInitial();
}
