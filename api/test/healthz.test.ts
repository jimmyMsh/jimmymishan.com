import { describe, expect, it } from "vitest";
import type { AppDeps } from "../src/app.js";
import { buildApp } from "../src/app.js";
import { openDeploysDb, openGuestbookDb, openSloDb } from "../src/db.js";
import { GithubCache } from "../src/github.js";
import type { LogTail } from "../src/logs/listener.js";
import { HostSampler } from "../src/metrics/host.js";
import { RequestCounter } from "../src/routes/metrics.js";
import { SloProber } from "../src/slo/probe.js";
import { SseHub } from "../src/sse.js";
import { DailyCaps, WriteCounters } from "../src/writes/gate.js";

const WRITE_SECRET = "test-write-secret";

function fakeDeps(overrides?: Partial<AppDeps>): AppDeps {
  const sloDb = openSloDb(":memory:");
  const writeCounters = new WriteCounters();
  return {
    config: {
      deployWebhookSecret: null,
      githubUser: "jimmyMsh",
      sseMaxConnections: 100,
      commit: "dev",
      dataDir: "/data",
      guestbookEnabled: true,
      contactDiscordWebhook: null,
      guestbookDiscordWebhook: null,
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
    guestbook: {
      db: openGuestbookDb(":memory:"),
      secret: WRITE_SECRET,
      enabled: true,
      caps: new DailyCaps(100, 1000),
      counters: writeCounters,
      webhookUrl: null,
    },
    contact: {
      webhookUrl: null,
      secret: WRITE_SECRET,
      caps: new DailyCaps(100, 1000),
      counters: writeCounters,
    },
    logTail: null,
    writeSecret: WRITE_SECRET,
    writeCounters,
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

describe("write-path route composition", () => {
  it("mounts GET /api/write-token", async () => {
    const res = await buildApp(fakeDeps()).request("/api/write-token");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
  });

  it("mounts GET /api/guestbook", async () => {
    const res = await buildApp(fakeDeps()).request("/api/guestbook");
    expect(res.status).toBe(200);
  });

  it("returns 503 from POST /api/contact when no webhook is configured", async () => {
    const res = await buildApp(fakeDeps()).request("/api/contact", {
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("returns 503 from GET /api/logs when the tail is disabled", async () => {
    const res = await buildApp(fakeDeps()).request("/api/logs");
    expect(res.status).toBe(503);
  });

  it("returns 200 from GET /api/logs when a tail is wired", async () => {
    const stubTail = { recent: () => [] } as unknown as LogTail;
    const res = await buildApp(fakeDeps({ logTail: stubTail })).request(
      "/api/logs",
    );
    expect(res.status).toBe(200);
  });
});

describe("write counters on /api/metrics", () => {
  it("reports accepted and rejected samples after driving the guestbook route", async () => {
    const app = buildApp(fakeDeps());

    const tokenRes = await app.request("/api/write-token");
    const { token } = await tokenRes.json();

    const acceptRes = await app.request("/api/guestbook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "vera", message: "hello there", token }),
    });
    expect(acceptRes.status).toBe(201);

    const honeypotRes = await app.request("/api/guestbook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "hello there",
        token,
        website: "http://spam.example",
      }),
    });
    expect(honeypotRes.status).toBe(201);

    const metricsRes = await app.request("/api/metrics");
    const text = await metricsRes.text();
    expect(text).toContain("jm_write_accepted_total");
    expect(text).toMatch(
      /jm_write_rejected_total\{[^}]*reason="honeypot"[^}]*\}/,
    );
  });
});
