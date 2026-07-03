import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { routePath } from "hono/route";
import type { GithubCache } from "../github.js";
import type { MetricSample, MetricSeries } from "../openmetrics.js";
import { renderMetrics } from "../openmetrics.js";
import type { SloProber } from "../slo/probe.js";
import { sloBlock } from "../slo/rollup.js";
import type { StatusDeps } from "./status.js";

const BYTES_PER_MB = 1024 * 1024;
const CONTENT_TYPE =
  "application/openmetrics-text; version=1.0.0; charset=utf-8";

export interface RouteCount {
  route: string;
  method: string;
  status: string;
  count: number;
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export class RequestCounter {
  private readonly counts = new Map<string, RouteCount>();

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      await next();
      // Index -1 resolves to the deepest matched route regardless of where
      // in the middleware chain this runs (see hono/route's routePath).
      const route = routePath(c, -1);
      const method = c.req.method;
      const status = statusClass(c.res.status);
      const key = `${route}\0${method}\0${status}`;

      const existing = this.counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        this.counts.set(key, { route, method, status, count: 1 });
      }
    };
  }

  snapshot(): RouteCount[] {
    return [...this.counts.values()];
  }
}

export interface MetricsRouteDeps extends StatusDeps {
  requests: RequestCounter;
  github: GithubCache;
  prober: SloProber;
  deploysTotal: () => number;
}

// Nearest-rank percentile, matching the method the SLO rollup uses so the
// last-hour gauges here agree with the dashboard's own percentile math.
function percentile(sortedAsc: number[], pct: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.min(
    Math.max(Math.ceil((pct / 100) * sortedAsc.length), 1),
    sortedAsc.length,
  );
  return sortedAsc[rank - 1] ?? null;
}

function percentileSamples(sortedAsc: number[], pct: number): MetricSample[] {
  const value = percentile(sortedAsc, pct);
  return value === null ? [] : [{ value }];
}

function gaugeSample(value: number | undefined | null): MetricSample[] {
  return value === undefined || value === null ? [] : [{ value }];
}

export function metricsRoute(deps: MetricsRouteDeps): Hono {
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.get("/api/metrics", (c) => {
    const sample = deps.host.latest();
    const containers = deps.containers();
    const nowSec = Math.floor(now() / 1000);
    const slo = sloBlock(deps.sloDb, nowSec);
    const recentLatencies = (slo?.recent ?? [])
      .map((r) => r.latency_ms)
      .sort((a, b) => a - b);

    const series: MetricSeries[] = [
      {
        name: "jm_host_cpu_percent",
        help: "Host CPU utilization percentage.",
        type: "gauge",
        samples: gaugeSample(sample?.cpu_pct),
      },
      {
        name: "jm_host_mem_used_bytes",
        help: "Host memory used, in bytes.",
        type: "gauge",
        samples: gaugeSample(sample ? sample.mem_used_mb * BYTES_PER_MB : null),
      },
      {
        name: "jm_host_mem_total_bytes",
        help: "Host memory total, in bytes.",
        type: "gauge",
        samples: gaugeSample(
          sample ? sample.mem_total_mb * BYTES_PER_MB : null,
        ),
      },
      {
        name: "jm_host_load1",
        help: "1-minute host load average.",
        type: "gauge",
        samples: gaugeSample(sample?.load1),
      },
      {
        name: "jm_container_up",
        help: "Whether a curated service's container is up.",
        type: "gauge",
        samples: containers.map((ct) => ({
          labels: { name: ct.name },
          value: ct.up ? 1 : 0,
        })),
      },
      {
        name: "jm_container_mem_bytes",
        help: "Curated service container memory usage, in bytes.",
        type: "gauge",
        samples: containers
          .filter(
            (ct): ct is typeof ct & { mem_mb: number } => ct.mem_mb !== null,
          )
          .map((ct) => ({
            labels: { name: ct.name },
            value: ct.mem_mb * BYTES_PER_MB,
          })),
      },
      {
        name: "jm_http_requests_total",
        help: "Total HTTP requests handled, by route, method, and status class.",
        type: "counter",
        samples: deps.requests.snapshot().map((r) => ({
          labels: { route: r.route, method: r.method, status: r.status },
          value: r.count,
        })),
      },
      {
        name: "jm_sse_connections",
        help: "Open /api/events connections.",
        type: "gauge",
        samples: [{ value: deps.hub.count }],
      },
      {
        name: "jm_deploys_total",
        help: "Total deploys recorded.",
        type: "counter",
        samples: [{ value: deps.deploysTotal() }],
      },
      {
        name: "jm_probe_latency_p50_ms",
        help: "SLO probe latency, 50th percentile over the last hour.",
        type: "gauge",
        samples: percentileSamples(recentLatencies, 50),
      },
      {
        name: "jm_probe_latency_p95_ms",
        help: "SLO probe latency, 95th percentile over the last hour.",
        type: "gauge",
        samples: percentileSamples(recentLatencies, 95),
      },
      {
        name: "jm_probe_latency_p99_ms",
        help: "SLO probe latency, 99th percentile over the last hour.",
        type: "gauge",
        samples: percentileSamples(recentLatencies, 99),
      },
      {
        name: "jm_github_cache_age_seconds",
        help: "Age of the cached GitHub repo data, in seconds.",
        type: "gauge",
        samples: gaugeSample(deps.github.cacheAgeSeconds()),
      },
    ];

    return c.body(renderMetrics(series), 200, {
      "Content-Type": CONTENT_TYPE,
    });
  });

  return app;
}
