import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDeploysDb } from "../src/db.js";
import { deploysRoutes } from "../src/routes/deploys.js";
import { SseHub } from "../src/sse.js";

const SECRET = "webhook-secret";
const FIXED_NOW = 1_700_000_000;

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function buildApp(opts?: { secret?: string | null; now?: () => number }) {
  const db = openDeploysDb(":memory:");
  const hub = new SseHub({ maxConnections: 10 });
  const broadcast = vi.spyOn(hub, "broadcast");
  const app = deploysRoutes({
    db,
    secret: opts?.secret === undefined ? SECRET : opts.secret,
    hub,
    now: opts?.now ?? (() => FIXED_NOW),
  });
  return { app, db, hub, broadcast };
}

function postWebhook(
  app: ReturnType<typeof buildApp>["app"],
  rawBody: string,
  signature?: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature !== undefined) headers["X-Deploy-Signature"] = signature;
  return app.request("/api/deploys/webhook", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

const VALID_BODY = JSON.stringify({
  sha: "abc123",
  tag: "v1.2.3",
  status: "ok",
  actor: "jimmyMsh",
  ts: FIXED_NOW,
});

describe("POST /api/deploys/webhook", () => {
  it("returns 503 when no secret is configured", async () => {
    const { app } = buildApp({ secret: null });

    const res = await postWebhook(app, VALID_BODY, sign(SECRET, VALID_BODY));

    expect(res.status).toBe(503);
  });

  it("rejects a request with no signature header", async () => {
    const { app } = buildApp();

    const res = await postWebhook(app, VALID_BODY);

    expect(res.status).toBe(401);
  });

  it("rejects a garbage signature header", async () => {
    const { app } = buildApp();

    const res = await postWebhook(app, VALID_BODY, "not-a-real-signature");

    expect(res.status).toBe(401);
  });

  it("rejects a well-formed signature computed with the wrong key", async () => {
    const { app } = buildApp();

    const wrongSignature = sign("some-other-key", VALID_BODY);
    const res = await postWebhook(app, VALID_BODY, wrongSignature);

    expect(res.status).toBe(401);
  });

  it("rejects a validly signed body whose timestamp is outside the freshness window", async () => {
    const staleBody = JSON.stringify({
      sha: "abc123",
      tag: "v1.2.3",
      status: "ok",
      actor: "jimmyMsh",
      ts: FIXED_NOW - 400,
    });
    const { app } = buildApp();

    const res = await postWebhook(app, staleBody, sign(SECRET, staleBody));

    expect(res.status).toBe(401);
  });

  it("rejects a validly signed body with an invalid status value", async () => {
    const badStatusBody = JSON.stringify({
      sha: "abc123",
      tag: "v1.2.3",
      status: "maybe",
      actor: "jimmyMsh",
      ts: FIXED_NOW,
    });
    const { app } = buildApp();

    const res = await postWebhook(
      app,
      badStatusBody,
      sign(SECRET, badStatusBody),
    );

    expect(res.status).toBe(400);
  });

  it("records a fresh deploy, broadcasts once, and returns recorded: true", async () => {
    const { app, db, broadcast } = buildApp();

    const res = await postWebhook(app, VALID_BODY, sign(SECRET, VALID_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });

    const rows = db.prepare("SELECT * FROM deploys").all();
    expect(rows).toHaveLength(1);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("deploy", {
      sha: "abc123",
      tag: "v1.2.3",
      status: "ok",
      at: FIXED_NOW,
    });
  });

  it("treats an exact replay (same sha + ts) as a no-op with no second broadcast", async () => {
    const { app, db, broadcast } = buildApp();

    const signature = sign(SECRET, VALID_BODY);
    const first = await postWebhook(app, VALID_BODY, signature);
    const second = await postWebhook(app, VALID_BODY, signature);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ recorded: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ recorded: false });

    const rows = db.prepare("SELECT * FROM deploys").all();
    expect(rows).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/deploys", () => {
  function seed(
    db: ReturnType<typeof buildApp>["db"],
    rows: Array<{
      sha: string;
      tag: string | null;
      status: string;
      actor: string | null;
      ts: number;
    }>,
  ) {
    const insert = db.prepare(
      "INSERT INTO deploys (sha, tag, status, actor, ts) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.sha, row.tag, row.status, row.actor, row.ts);
    }
  }

  it("returns deploys newest-first with the default limit of 20", async () => {
    const { app, db } = buildApp();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      sha: `sha-${i}`,
      tag: null,
      status: "ok",
      actor: null,
      ts: FIXED_NOW + i,
    }));
    seed(db, rows);

    const res = await app.request("/api/deploys");
    const body = (await res.json()) as { deploys: Array<{ sha: string }> };

    expect(body.deploys).toHaveLength(20);
    expect(body.deploys[0]?.sha).toBe("sha-24");
    expect(body.deploys[19]?.sha).toBe("sha-5");
  });

  it("respects an explicit limit", async () => {
    const { app, db } = buildApp();
    seed(db, [
      { sha: "a", tag: null, status: "ok", actor: null, ts: FIXED_NOW },
      { sha: "b", tag: null, status: "ok", actor: null, ts: FIXED_NOW + 1 },
      { sha: "c", tag: null, status: "ok", actor: null, ts: FIXED_NOW + 2 },
    ]);

    const res = await app.request("/api/deploys?limit=2");
    const body = (await res.json()) as { deploys: Array<{ sha: string }> };

    expect(body.deploys).toHaveLength(2);
    expect(body.deploys.map((d) => d.sha)).toEqual(["c", "b"]);
  });

  it("caps the limit at 100 even when a larger value is requested", async () => {
    const { app, db } = buildApp();
    const rows = Array.from({ length: 150 }, (_, i) => ({
      sha: `sha-${i}`,
      tag: null,
      status: "ok",
      actor: null,
      ts: FIXED_NOW + i,
    }));
    seed(db, rows);

    const res = await app.request("/api/deploys?limit=1000");
    const body = (await res.json()) as { deploys: Array<{ sha: string }> };

    expect(body.deploys).toHaveLength(100);
    expect(body.deploys[0]?.sha).toBe("sha-149");
  });

  it("round-trips null tag and actor", async () => {
    const { app, db } = buildApp();
    seed(db, [
      {
        sha: "abc123",
        tag: null,
        status: "failed",
        actor: null,
        ts: FIXED_NOW,
      },
    ]);

    const res = await app.request("/api/deploys");
    const body = (await res.json()) as { deploys: unknown[] };

    expect(body.deploys).toEqual([
      {
        sha: "abc123",
        tag: null,
        status: "failed",
        actor: null,
        at: FIXED_NOW,
      },
    ]);
  });
});
