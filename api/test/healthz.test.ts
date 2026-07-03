import { describe, expect, it } from "vitest";
import type { AppDeps } from "../src/app.js";
import { buildApp } from "../src/app.js";
import { openDeploysDb, openSloDb } from "../src/db.js";
import { GithubCache } from "../src/github.js";
import { HostSampler } from "../src/metrics/host.js";
import { RequestCounter } from "../src/routes/metrics.js";
import { SloProber } from "../src/slo/probe.js";
import { SseHub } from "../src/sse.js";

function fakeDeps(overrides?: Partial<AppDeps>): AppDeps {
  const sloDb = openSloDb(":memory:");
  return {
    config: {
      deployWebhookSecret: null,
      githubUser: "jimmyMsh",
      sseMaxConnections: 100,
      commit: "dev",
      dataDir: "/data",
      guestbookEnabled: true,
      contactDiscordWebhook: null,
      logTailEnabled: true,
      logTailAllowPrivate: false,
      writeSecret: null,
    },
    host: new HostSampler(),
    containers: () => [],
    hub: new SseHub({ maxConnections: 100 }),
    deploysDb: openDeploysDb(":memory:"),
    sloDb,
    startedAt: 0,
    now: () => 1000,
    latestMetrics: () => null,
    github: new GithubCache({ user: "jimmyMsh" }),
    requests: new RequestCounter(),
    prober: new SloProber({ db: sloDb }),
    deploysTotal: () => 0,
    ...overrides,
  };
}

describe("GET /api/healthz", () => {
  it("returns the health contract", async () => {
    const res = await buildApp(fakeDeps()).request("/api/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_s).toBe("number");
    expect(body.commit).toBe("dev");
  });
});

describe("buildApp route composition", () => {
  it("serves all six routes without a 404", async () => {
    const app = buildApp(fakeDeps());

    for (const path of [
      "/api/status",
      "/api/github",
      "/api/deploys",
      "/api/metrics",
      "/api/healthz",
    ]) {
      const res = await app.request(path);
      expect(res.status, `${path} should be mounted`).not.toBe(404);
    }

    // /api/events streams; assert it's mounted, then tear the stream down.
    const events = await app.request("/api/events");
    expect(events.status, "/api/events should be mounted").not.toBe(404);
    await events.body?.cancel();
  });
});
