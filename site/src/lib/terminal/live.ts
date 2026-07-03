import { ApiError, apiFetch } from "../api/client";
import type { ApiStatus, DeployRecord, DeploysResponse } from "../api/types";
import type { CommandRegistry } from "./registry";
import { makeTopCommand } from "./top";
import type { Command, CommandContext, Line } from "./types";
import { errorLine, hint, link, text } from "./types";

export interface LiveDeps {
  fetchFn?: typeof fetch;
  makeSource?: (url: string) => EventSource;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) {
    return `${days} day${days === 1 ? "" : "s"}, ${hours}:${String(minutes).padStart(2, "0")}`;
  }
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}`;
  return `${minutes} min`;
}

function relTime(fromSec: number, nowSec: number): string {
  const diff = Math.max(0, Math.round(nowSec - fromSec));
  if (diff < 60) return `${diff}s ago`;
  const min = Math.round(diff / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function absTime(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatUptimeLine(status: ApiStatus, now: Date): Line {
  const time = now.toISOString().slice(11, 19);
  const { load1, load5, load15, uptime_s } = status.host;
  return text(
    `${time} up ${formatDuration(uptime_s)}, load average: ${load1}, ${load5}, ${load15}`,
  );
}

function col(value: string, width: number): string {
  return value.padStart(width);
}

export function formatFreeLines(status: ApiStatus): Line[] {
  const total = Math.round(status.host.mem_total_mb);
  const used = Math.round(status.host.mem_used_mb);
  const free = total - used;
  const header = `      ${col("total", 11)}${col("used", 11)}${col("free", 11)}${col("available", 11)}`;
  const row = `Mem:  ${col(String(total), 11)}${col(String(used), 11)}${col(String(free), 11)}${col(String(free), 11)}`;
  return [text(header), text(row)];
}

function padEnd(value: string, width: number): string {
  return value.padEnd(width);
}

export function formatDockerLines(status: ApiStatus): Line[] {
  const header = `${padEnd("NAME", 10)}${padEnd("STATUS", 9)}${padEnd("CPU", 8)}MEM`;
  const rows = status.containers.map((c) => {
    const cpu = c.cpu_pct === null ? "-" : `${c.cpu_pct}%`;
    const mem = c.mem_mb === null ? "-" : `${c.mem_mb} MiB`;
    return `${padEnd(c.name, 10)}${padEnd(c.up ? "up" : "down", 9)}${padEnd(cpu, 8)}${mem}`;
  });
  return [text(header), ...rows.map((r) => text(r))];
}

export function formatDeployLines(deploys: DeployRecord[], now: Date): Line[] {
  const nowSec = Math.floor(now.getTime() / 1000);
  const rows = deploys.map((d) =>
    text(`${d.sha}  ${d.status}  ${relTime(d.at, nowSec)} (${absTime(d.at)})`),
  );
  return [...rows, hint("# see the full feed at /status")];
}

export function formatStatusLines(status: ApiStatus, now: Date): Line[] {
  const nowSec = Math.floor(now.getTime() / 1000);
  const { host } = status;

  const hostLine = text(
    `host: cpu ${host.cpu_pct}% · mem ${host.mem_used_mb}/${host.mem_total_mb} MiB · load ${host.load1} ${host.load5} ${host.load15} · up ${formatDuration(host.uptime_s)}`,
  );

  const containersLine = text(
    `containers: ${status.containers
      .map((c) => {
        const base = `${c.name} ${c.up ? "up" : "down"}`;
        return c.cpu_pct === null || c.mem_mb === null
          ? base
          : `${base} (${c.cpu_pct}% · ${c.mem_mb} MiB)`;
      })
      .join(" · ")}`,
  );

  const deployLine = text(
    status.deploy === null
      ? "last deploy: none yet"
      : `last deploy: ${status.deploy.sha} ${status.deploy.status} · ${relTime(status.deploy.at, nowSec)}`,
  );

  const presenceLine = text(`presence: ${status.presence} here now`);

  const sloLine = text(
    status.slo === null
      ? "uptime: no data yet"
      : `uptime (${status.slo.window_days}d window): ${status.slo.availability_pct}% avail · p50 ${status.slo.p50_ms}ms · p99 ${status.slo.p99_ms}ms`,
  );

  const dashboardLine: Line = {
    segments: [{ text: "full dashboard: " }, link("/status", "/status")],
    kind: "output",
  };

  return [
    hostLine,
    containersLine,
    deployLine,
    presenceLine,
    sloLine,
    dashboardLine,
  ];
}

export const UNREACHABLE_SUFFIX =
  "can't reach the api — try the dashboard at /status";

export function unreachableLine(cmd: string): Line {
  return errorLine(`${cmd}: ${UNREACHABLE_SUFFIX}`);
}

async function runLive(
  cmd: string,
  ctx: CommandContext,
  load: () => Promise<Line[]>,
): Promise<void> {
  try {
    for (const line of await load()) ctx.writer.writeLine(line);
  } catch (err) {
    if (err instanceof ApiError) {
      if (ctx.signal.aborted) return;
      ctx.writer.writeLine(unreachableLine(cmd));
      return;
    }
    throw err;
  }
}

function fetchStatus(
  ctx: CommandContext,
  fetchFn: typeof fetch | undefined,
): Promise<ApiStatus> {
  return apiFetch<ApiStatus>("/api/status", { signal: ctx.signal, fetchFn });
}

export function registerLiveCommands(
  reg: CommandRegistry,
  deps: LiveDeps = {},
): void {
  const { fetchFn, makeSource } = deps;

  // The page-load prefetch is memoized; the first `status` reuses that snapshot
  // (already fetched for autoplay) instead of hitting the api again. A null
  // prefetch, and every later run, fetches fresh.
  let statusPrefetchPending = true;

  const commands: Command[] = [
    {
      name: "status",
      summary: "live status snapshot",
      run(ctx) {
        if (statusPrefetchPending) {
          statusPrefetchPending = false;
          return runLive("status", ctx, async () => {
            const status =
              (await prefetchStatus()) ?? (await fetchStatus(ctx, fetchFn));
            return formatStatusLines(status, ctx.now());
          });
        }
        return runLive("status", ctx, async () =>
          formatStatusLines(await fetchStatus(ctx, fetchFn), ctx.now()),
        );
      },
    },
    {
      name: "uptime",
      summary: "host uptime and load",
      run(ctx) {
        return runLive("uptime", ctx, async () => [
          formatUptimeLine(await fetchStatus(ctx, fetchFn), ctx.now()),
        ]);
      },
    },
    {
      name: "free",
      summary: "memory usage",
      run(ctx) {
        return runLive("free", ctx, async () =>
          formatFreeLines(await fetchStatus(ctx, fetchFn)),
        );
      },
    },
    {
      name: "docker",
      summary: "container status",
      run(ctx) {
        return runLive("docker", ctx, async () =>
          formatDockerLines(await fetchStatus(ctx, fetchFn)),
        );
      },
    },
    {
      name: "deploys",
      summary: "recent deploys",
      run(ctx) {
        return runLive("deploys", ctx, async () => {
          const { deploys } = await apiFetch<DeploysResponse>(
            "/api/deploys?limit=10",
            { signal: ctx.signal, fetchFn },
          );
          return formatDeployLines(deploys, ctx.now());
        });
      },
    },
    makeTopCommand({ makeSource, unreachableLine: unreachableLine("top") }),
  ];

  for (const cmd of commands) reg.register(cmd);
}

let statusPromise: Promise<ApiStatus | null> | null = null;

export function prefetchStatus(timeoutMs = 800): Promise<ApiStatus | null> {
  if (!statusPromise) {
    statusPromise = apiFetch<ApiStatus>("/api/status", { timeoutMs }).catch(
      () => null,
    );
  }
  return statusPromise;
}
