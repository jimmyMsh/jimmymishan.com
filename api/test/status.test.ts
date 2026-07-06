import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { openDeploysDb, openSloDb } from "../src/db.js";
import { HostSampler } from "../src/metrics/host.js";
import type { StatusDeps } from "../src/routes/status.js";
import { statusRoute } from "../src/routes/status.js";
import { SseHub } from "../src/sse.js";

const FIXTURES_PROC_DIR = join(import.meta.dirname, "fixtures", "proc");

const CONFIG: Config = {
  deployWebhookSecret: null,
  githubUser: "jimmyMsh",
  sseMaxConnections: 100,
  commit: "abc1234",
  dataDir: "/data",
  guestbookEnabled: true,
  contactDiscordWebhook: null,
  guestbookDiscordWebhook: null,
  logTailEnabled: true,
  logTailAllowPrivate: false,
  writeSecret: null,
};

function buildHost(): HostSampler {
  const host = new HostSampler({ procDir: FIXTURES_PROC_DIR, now: () => 5000 });
  host.start();
  host.stop();
  return host;
}

function seedSlo(db: DatabaseSync): void {
  const insertProbe = db.prepare(
    "INSERT INTO probes (ts, ok, latency_ms) VALUES (?, ?, ?)",
  );
  insertProbe.run(9_500, 1, 40);
  insertProbe.run(9_560, 1, 44);
  const insertDaily = db.prepare(
    "INSERT INTO daily (day, total, ok, p50_ms, p95_ms, p99_ms) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertDaily.run("2026-07-01", 100, 100, 41, 51, 60);
}

function seedDeploy(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO deploys (sha, tag, status, actor, ts) VALUES (?, ?, ?, ?, ?)",
  ).run("c584a9e", "c584a9e", "ok", "jimmyMsh", 4_242);
}

function buildDeps(overrides?: Partial<StatusDeps>): StatusDeps {
  const hub = new SseHub({ maxConnections: 10 });
  hub.add({ send: () => {}, close: () => {} });
  hub.add({ send: () => {}, close: () => {} });
  hub.add({ send: () => {}, close: () => {} });

  return {
    config: CONFIG,
    host: buildHost(),
    containers: () => [{ name: "nginx", up: true, cpu_pct: 0.1, mem_mb: 12 }],
    hub,
    deploysDb: openDeploysDb(":memory:"),
    sloDb: openSloDb(":memory:"),
    startedAt: 5_000 - 4_242_000,
    now: () => 5_000,
    ...overrides,
  };
}

describe("GET /api/status", () => {
  it("returns the full shape with every block populated", async () => {
    const deploysDb = openDeploysDb(":memory:");
    seedDeploy(deploysDb);
    const sloDb = openSloDb(":memory:");
    seedSlo(sloDb);

    const deps = buildDeps({ deploysDb, sloDb });
    const app = statusRoute(deps);

    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      host: {
        cpu_pct: 0,
        mem_used_mb: 6000,
        mem_total_mb: 8000,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        uptime_s: 123456,
      },
      history: [{ ts: 5, cpu_pct: 0, mem_used_mb: 6000 }],
      containers: [{ name: "nginx", up: true, cpu_pct: 0.1, mem_mb: 12 }],
      deploy: {
        sha: "c584a9e",
        tag: "c584a9e",
        status: "ok",
        at: 4_242,
      },
      presence: 3,
      slo: {
        window_days: 90,
        availability_pct: 100,
        p50_ms: 41,
        p99_ms: 60,
        days: [{ day: "2026-07-01", availability_pct: 100, p95_ms: 51 }],
        recent: [
          { ts: 9_500, latency_ms: 40 },
          { ts: 9_560, latency_ms: 44 },
        ],
      },
      commit: "abc1234",
      api_uptime_s: 4_242,
    });
  });

  it("returns deploy: null when the deploys table is empty", async () => {
    const deps = buildDeps();
    const app = statusRoute(deps);

    const res = await app.request("/api/status");
    const body = (await res.json()) as { deploy: unknown };

    expect(body.deploy).toBeNull();
  });

  it("returns slo: null when the slo db has no data at all", async () => {
    const deps = buildDeps();
    const app = statusRoute(deps);

    const res = await app.request("/api/status");
    const body = (await res.json()) as { slo: unknown };

    expect(body.slo).toBeNull();
  });

  it("mirrors the sampler's ring buffer in history", async () => {
    const deps = buildDeps();
    const app = statusRoute(deps);

    const res = await app.request("/api/status");
    const body = (await res.json()) as { history: unknown };

    expect(body.history).toEqual(deps.host.history());
  });
});
