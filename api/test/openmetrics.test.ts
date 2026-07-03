import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDeploysDb, openSloDb } from "../src/db.js";
import { GithubCache } from "../src/github.js";
import { HostSampler } from "../src/metrics/host.js";
import type { MetricSeries } from "../src/openmetrics.js";
import { renderMetrics } from "../src/openmetrics.js";
import { metricsRoute, RequestCounter } from "../src/routes/metrics.js";
import { SloProber } from "../src/slo/probe.js";
import { SseHub } from "../src/sse.js";

describe("renderMetrics", () => {
  it("escapes backslash, double-quote, and newline in label values", () => {
    const series: MetricSeries[] = [
      {
        name: "jm_test_gauge",
        help: "A test gauge.",
        type: "gauge",
        samples: [{ labels: { msg: 'back\\slash "quote"\nline' }, value: 1 }],
      },
    ];

    const text = renderMetrics(series);

    expect(text).toContain(
      'jm_test_gauge{msg="back\\\\slash \\"quote\\"\\nline"} 1',
    );
  });

  it("renders a gauge with TYPE/HELP using the given name unchanged", () => {
    const series: MetricSeries[] = [
      {
        name: "jm_sse_connections",
        help: "Open connections.",
        type: "gauge",
        samples: [{ value: 3 }],
      },
    ];

    const text = renderMetrics(series);

    expect(text).toContain("# TYPE jm_sse_connections gauge\n");
    expect(text).toContain("# HELP jm_sse_connections Open connections.\n");
    expect(text).toContain("jm_sse_connections 3\n");
  });

  it("renders a counter's TYPE/HELP with the _total suffix stripped, sample keeps it", () => {
    const series: MetricSeries[] = [
      {
        name: "jm_deploys_total",
        help: "Total deploys recorded.",
        type: "counter",
        samples: [{ value: 5 }],
      },
    ];

    const text = renderMetrics(series);

    expect(text).toContain("# TYPE jm_deploys counter\n");
    expect(text).toContain("# HELP jm_deploys Total deploys recorded.\n");
    expect(text).toContain("jm_deploys_total 5\n");
  });

  it("omits a family with no samples entirely", () => {
    const series: MetricSeries[] = [
      {
        name: "jm_github_cache_age_seconds",
        help: "Cache age.",
        type: "gauge",
        samples: [],
      },
    ];

    const text = renderMetrics(series);

    expect(text).not.toContain("jm_github_cache_age_seconds");
  });

  it("ends a full render with the EOF marker", () => {
    const series: MetricSeries[] = [
      {
        name: "jm_sse_connections",
        help: "Open connections.",
        type: "gauge",
        samples: [{ value: 1 }],
      },
    ];

    const text = renderMetrics(series);

    expect(text.endsWith("# EOF\n")).toBe(true);
  });

  it("renders EOF alone when every family is empty", () => {
    expect(renderMetrics([])).toBe("# EOF\n");
  });
});

const FIXTURES_PROC_DIR = join(import.meta.dirname, "fixtures", "proc");

async function buildMetricsApp() {
  const host = new HostSampler({ procDir: FIXTURES_PROC_DIR, now: () => 1000 });
  host.start();
  host.stop();

  const hub = new SseHub({ maxConnections: 10 });
  hub.add({ send: () => {}, close: () => {} });

  const sloDb = openSloDb(":memory:");
  sloDb
    .prepare("INSERT INTO probes (ts, ok, latency_ms) VALUES (?, ?, ?)")
    .run(900, 1, 42);

  const requests = new RequestCounter();

  const github = new GithubCache({
    user: "jimmyMsh",
    fetchFn: async () => new Response("[]"),
    now: () => 5000,
  });
  github.start();
  await vi.advanceTimersByTimeAsync(0);
  github.stop();

  const deps = {
    config: {
      deployWebhookSecret: null,
      githubUser: "jimmyMsh",
      sseMaxConnections: 100,
      commit: "abc1234",
      dataDir: "/data",
      guestbookEnabled: true,
      contactDiscordWebhook: null,
      logTailEnabled: true,
      logTailAllowPrivate: false,
      writeSecret: null,
    },
    host,
    containers: () => [{ name: "nginx", up: true, cpu_pct: 0.1, mem_mb: 12 }],
    hub,
    deploysDb: openDeploysDb(":memory:"),
    sloDb,
    startedAt: 0,
    now: () => 1000,
    requests,
    github,
    prober: new SloProber({ db: openSloDb(":memory:") }),
    deploysTotal: () => 7,
  };

  const drivenApp = new Hono();
  drivenApp.use(requests.middleware());
  drivenApp.get("/api/status", (c) => c.text("ok"));

  return { app: metricsRoute(deps), drivenApp };
}

describe("GET /api/metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes the sse connections gauge", async () => {
    const { app } = await buildMetricsApp();

    const res = await app.request("/api/metrics");
    const text = await res.text();

    expect(text).toContain("jm_sse_connections 1\n");
  });

  it("includes container_up with the curated service label", async () => {
    const { app } = await buildMetricsApp();

    const res = await app.request("/api/metrics");
    const text = await res.text();

    expect(text).toContain('jm_container_up{name="nginx"} 1\n');
  });

  it("includes http_requests_total after a counted request", async () => {
    const { app, drivenApp } = await buildMetricsApp();
    await drivenApp.request("/api/status");

    const res = await app.request("/api/metrics");
    const text = await res.text();

    expect(text).toContain(
      'jm_http_requests_total{route="/api/status",method="GET",status="2xx"} 1\n',
    );
  });

  it("includes the github cache age gauge", async () => {
    const { app } = await buildMetricsApp();

    const res = await app.request("/api/metrics");
    const text = await res.text();

    expect(text).toMatch(/jm_github_cache_age_seconds \d+\n/);
  });

  it("includes probe latency percentile gauges", async () => {
    const { app } = await buildMetricsApp();

    const res = await app.request("/api/metrics");
    const text = await res.text();

    expect(text).toContain("jm_probe_latency_p50_ms 42\n");
    expect(text).toContain("jm_probe_latency_p95_ms 42\n");
    expect(text).toContain("jm_probe_latency_p99_ms 42\n");
  });

  it("ends with the EOF marker", async () => {
    const { app } = await buildMetricsApp();

    const res = await app.request("/api/metrics");
    const text = await res.text();

    expect(text.endsWith("# EOF\n")).toBe(true);
  });

  it("sets the openmetrics content type", async () => {
    const { app } = await buildMetricsApp();

    const res = await app.request("/api/metrics");

    expect(res.headers.get("content-type")).toBe(
      "application/openmetrics-text; version=1.0.0; charset=utf-8",
    );
  });
});
