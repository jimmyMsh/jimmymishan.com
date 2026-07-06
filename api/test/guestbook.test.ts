import { afterEach, describe, expect, it, vi } from "vitest";
import { openGuestbookDb } from "../src/db.js";
import { sendGuestbookEmbed } from "../src/discord.js";
import { guestbookRoutes } from "../src/routes/guestbook.js";
import {
  clientIp,
  DailyCaps,
  hashIp,
  mintToken,
  WriteCounters,
} from "../src/writes/gate.js";

const SECRET = "guestbook-secret";
const FIXED_NOW = 1_700_000_000;

function buildApp(opts?: {
  enabled?: boolean;
  secret?: string;
  now?: () => number;
  perIpCap?: number;
  globalCap?: number;
  webhookUrl?: string | null;
  fetchFn?: typeof fetch;
}) {
  const db = openGuestbookDb(":memory:");
  const secret = opts?.secret ?? SECRET;
  const caps = new DailyCaps(opts?.perIpCap ?? 100, opts?.globalCap ?? 1000);
  const counters = new WriteCounters();
  const app = guestbookRoutes({
    db,
    secret,
    enabled: opts?.enabled ?? true,
    caps,
    counters,
    webhookUrl: opts?.webhookUrl ?? null,
    fetchFn: opts?.fetchFn,
    nowSec: opts?.now ?? (() => FIXED_NOW),
  });
  return { app, db, caps, counters, secret };
}

function validBody(
  secret: string,
  overrides?: Partial<{
    name: string;
    message: string;
    token: string;
    website: string;
  }>,
) {
  return {
    name: "vera",
    message: "hello there",
    token: mintToken(secret, FIXED_NOW),
    ...overrides,
  };
}

function postGuestbook(
  app: ReturnType<typeof buildApp>["app"],
  body: Record<string, unknown> | undefined,
  opts?: { ip?: string; rawBody?: string; contentType?: string },
) {
  const headers: Record<string, string> = {
    "content-type": opts?.contentType ?? "application/json",
  };
  if (opts?.ip !== undefined) headers["X-Real-IP"] = opts.ip;
  return app.request("/api/guestbook", {
    method: "POST",
    headers,
    body: opts?.rawBody ?? JSON.stringify(body),
  });
}

function seedEntry(
  db: ReturnType<typeof buildApp>["db"],
  row: {
    name: string;
    message: string;
    ts: number;
    ip_hash: string;
    hidden?: number;
  },
) {
  db.prepare(
    "INSERT INTO entries (name, message, ts, ip_hash, hidden) VALUES (?, ?, ?, ?, ?)",
  ).run(row.name, row.message, row.ts, row.ip_hash, row.hidden ?? 0);
}

describe("clientIp", () => {
  it('defaults to "local" when no header value is given', () => {
    expect(clientIp(undefined)).toBe("local");
  });

  it("returns the header value verbatim when present", () => {
    expect(clientIp("1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("GET /api/guestbook", () => {
  it("returns an empty list and a verifiable token for an empty db", async () => {
    const { app, secret } = buildApp();

    const res = await app.request("/api/guestbook");
    const body = (await res.json()) as { entries: unknown[]; token: string };

    expect(res.status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(typeof body.token).toBe("string");
    expect(body.token).toBe(mintToken(secret, FIXED_NOW));
  });

  it("excludes hidden rows", async () => {
    const { app, db } = buildApp();
    seedEntry(db, {
      name: "a",
      message: "visible",
      ts: FIXED_NOW,
      ip_hash: "hash-a",
      hidden: 0,
    });
    seedEntry(db, {
      name: "b",
      message: "hidden one",
      ts: FIXED_NOW + 1,
      ip_hash: "hash-b",
      hidden: 1,
    });

    const res = await app.request("/api/guestbook");
    const body = (await res.json()) as {
      entries: Array<{ message: string }>;
    };

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.message).toBe("visible");
  });

  it("returns only the newest 100 of 101 rows", async () => {
    const { app, db } = buildApp();
    for (let i = 0; i < 101; i++) {
      seedEntry(db, {
        name: `n${i}`,
        message: `m${i}`,
        ts: FIXED_NOW + i,
        ip_hash: `hash-${i}`,
      });
    }

    const res = await app.request("/api/guestbook");
    const body = (await res.json()) as { entries: Array<{ name: string }> };

    expect(body.entries).toHaveLength(100);
    expect(body.entries[0]?.name).toBe("n100");
    expect(body.entries[99]?.name).toBe("n1");
  });

  it("never exposes ip_hash or hidden in the response", async () => {
    const { app, db } = buildApp();
    seedEntry(db, {
      name: "a",
      message: "hi",
      ts: FIXED_NOW,
      ip_hash: "secret-hash-value",
      hidden: 0,
    });

    const res = await app.request("/api/guestbook");
    const raw = await res.text();

    expect(raw).not.toContain("ip_hash");
    expect(raw).not.toContain("secret-hash-value");
    expect(raw).not.toContain("hidden");
  });

  it("still serves entries when signing is disabled", async () => {
    const { app, db } = buildApp({ enabled: false });
    seedEntry(db, {
      name: "a",
      message: "hi",
      ts: FIXED_NOW,
      ip_hash: "hash-a",
    });

    const res = await app.request("/api/guestbook");

    expect(res.status).toBe(200);
  });
});

describe("POST /api/guestbook", () => {
  it("returns 503 disabled and counts it, without touching the db", async () => {
    const { app, db, counters, secret } = buildApp({ enabled: false });

    const res = await postGuestbook(app, validBody(secret));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "disabled" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "disabled", count: 1 },
      ]),
    );
    expect(db.prepare("SELECT * FROM entries").all()).toHaveLength(0);
  });

  it("rejects an oversized body before parsing, ahead of the token check", async () => {
    const { app, counters, secret } = buildApp();
    const oversized = JSON.stringify(
      validBody(secret, { message: "a".repeat(9000) }),
    );
    expect(oversized.length).toBeGreaterThan(8192);

    const res = await postGuestbook(app, undefined, { rawBody: oversized });
    const body = (await res.json()) as { error: string; field?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid");
    expect(body.field).toBeUndefined();
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects malformed JSON", async () => {
    const { app, counters } = buildApp();

    const res = await postGuestbook(app, undefined, { rawBody: "{not json" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects a non-JSON content-type even with an otherwise-valid body", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postGuestbook(app, validBody(secret), {
      contentType: "text/plain",
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects a missing or invalid token with field: token", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { token: "garbage" }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid", field: "token" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "token", count: 1 },
      ]),
    );
  });

  it("rejects a request with no token field at all", async () => {
    const { app, secret } = buildApp();
    const { token: _token, ...withoutToken } = validBody(secret);

    const res = await postGuestbook(app, withoutToken);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "token" });
  });

  it("returns a fake 201 for a honeypot hit and stores nothing", async () => {
    const { app, db, counters, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { website: "https://spam.example" }),
    );
    const body = (await res.json()) as {
      entry: { id: number; name: string; message: string; ts: number };
    };

    expect(res.status).toBe(201);
    expect(body.entry.id).toBe(0);
    expect(Object.keys(body.entry).sort()).toEqual([
      "id",
      "message",
      "name",
      "ts",
    ]);
    expect(db.prepare("SELECT * FROM entries").all()).toHaveLength(0);
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "honeypot", count: 1 },
      ]),
    );
  });

  it("returns a fake 201 for a blocklisted ip and stores nothing", async () => {
    const { app, db, counters, secret } = buildApp();
    const blockedHash = hashIp(secret, "8.8.8.8");
    db.prepare("INSERT INTO blocklist (ip_hash, ts) VALUES (?, ?)").run(
      blockedHash,
      FIXED_NOW,
    );

    const res = await postGuestbook(app, validBody(secret), {
      ip: "8.8.8.8",
    });
    const body = (await res.json()) as {
      entry: { id: number; name: string; message: string; ts: number };
    };

    expect(res.status).toBe(201);
    expect(body.entry.id).toBe(0);
    expect(Object.keys(body.entry).sort()).toEqual([
      "id",
      "message",
      "name",
      "ts",
    ]);
    expect(db.prepare("SELECT * FROM entries").all()).toHaveLength(0);
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "blocked", count: 1 },
      ]),
    );
  });

  it("rejects an empty message", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postGuestbook(app, validBody(secret, { message: "  " }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "message" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects a 281-character message", async () => {
    const { app, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { message: "a".repeat(281) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "message" });
  });

  it("accepts a 280-character message", async () => {
    const { app, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { message: "a".repeat(280) }),
    );

    expect(res.status).toBe(201);
  });

  it("rejects a name longer than 32 characters", async () => {
    const { app, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { name: "n".repeat(33) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "name" });
  });

  it("defaults a missing name to anonymous", async () => {
    const { app, secret } = buildApp();
    const { name: _name, ...withoutName } = validBody(secret);

    const res = await postGuestbook(app, withoutName);
    const body = (await res.json()) as { entry: { name: string } };

    expect(res.status).toBe(201);
    expect(body.entry.name).toBe("anonymous");
  });

  it("rejects a URL in the message", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { message: "check https://evil.example out" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "url" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects a URL in the name", async () => {
    const { app, secret } = buildApp();

    const res = await postGuestbook(
      app,
      validBody(secret, { name: "www.spam.example" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "url" });
  });

  it("enforces the per-ip daily cap and returns rate_limited", async () => {
    const { app, counters, secret } = buildApp({ perIpCap: 1 });

    const first = await postGuestbook(app, validBody(secret), {
      ip: "1.1.1.1",
    });
    const second = await postGuestbook(
      app,
      validBody(secret, { message: "second message" }),
      { ip: "1.1.1.1" },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "rejected", reason: "rate", count: 1 },
      ]),
    );
  });

  it("tracks two ips independently under the per-ip cap", async () => {
    const { app, secret } = buildApp({ perIpCap: 1 });

    const first = await postGuestbook(app, validBody(secret), {
      ip: "1.1.1.1",
    });
    const second = await postGuestbook(
      app,
      validBody(secret, { message: "from another ip" }),
      { ip: "2.2.2.2" },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it("inserts a real entry, accepts it, and returns the stored fields", async () => {
    const { app, db, counters, secret } = buildApp();

    const res = await postGuestbook(app, validBody(secret));
    const body = (await res.json()) as {
      entry: { id: number; name: string; message: string; ts: number };
    };

    expect(res.status).toBe(201);
    expect(body.entry).toEqual({
      id: expect.any(Number),
      name: "vera",
      message: "hello there",
      ts: FIXED_NOW,
    });
    expect(db.prepare("SELECT * FROM entries").all()).toHaveLength(1);
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "accepted", count: 1 },
      ]),
    );
  });

  it("stores the hashed ip, never the raw header value", async () => {
    const { app, db, secret } = buildApp();

    await postGuestbook(app, validBody(secret), { ip: "9.9.9.9" });

    const row = db.prepare("SELECT ip_hash FROM entries").get() as {
      ip_hash: string;
    };
    expect(row.ip_hash).toBe(hashIp(secret, "9.9.9.9"));
    expect(row.ip_hash).not.toBe("9.9.9.9");
  });
});

const WEBHOOK_URL = "https://discord.com/api/webhooks/123456/token-abc";

function jsonResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

function parsedBody(fetchFn: ReturnType<typeof vi.fn>): {
  url: unknown;
  init: RequestInit;
  body: {
    content: string;
    embeds: Array<{
      title: string;
      description: string;
      fields: Array<{ name: string; value: string }>;
      timestamp: string;
    }>;
    allowed_mentions: { parse: string[] };
  };
} {
  const [url, init] = fetchFn.mock.calls[0] as [unknown, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe("sendGuestbookEmbed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the pinned payload with paste-ready moderation commands", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));

    const ok = await sendGuestbookEmbed(
      WEBHOOK_URL,
      { id: 42, name: "vera", message: "hello there", ipHash: "abc123" },
      fetchFn,
    );

    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const { url, init, body } = parsedBody(fetchFn);
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toMatch(
      /application\/json/i,
    );
    expect(body.embeds[0].title).toBe("Guestbook entry #42");
    expect(body.embeds[0].description).toBe("hello there");
    expect(body.embeds[0].fields).toEqual([{ name: "From", value: "vera" }]);
    // Moderation commands live in the message content (not an embed field) as
    // two separate fenced blocks, so Discord mobile shows a per-block copy
    // button; embed-field text isn't selectable on mobile.
    expect(body.content).toContain(
      "docker compose -f compose.prod.yaml exec api node api/dist/cli.js guestbook delete 42'",
    );
    // Each command is its own fenced block (two balanced ``` pairs, one command
    // per block) so the Discord mobile app renders a per-block copy button.
    expect(body.content).toMatch(
      /^```\nssh vps '[^\n]*guestbook delete 42'\n```\n```\nssh vps '[^\n]*guestbook block abc123'\n```$/,
    );
    // Paste-command injection guard: visitor text never enters the commands.
    expect(body.content).not.toContain("vera");
    expect(body.content).not.toContain("hello there");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(Number.isNaN(Date.parse(body.embeds[0].timestamp))).toBe(false);
  });

  it("returns false on a non-2xx response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500));

    await expect(
      sendGuestbookEmbed(
        WEBHOOK_URL,
        { id: 1, name: "a", message: "b", ipHash: "c" },
        fetchFn,
      ),
    ).resolves.toBe(false);
  });

  it("returns false when fetch throws a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      sendGuestbookEmbed(
        WEBHOOK_URL,
        { id: 1, name: "a", message: "b", ipHash: "c" },
        fetchFn,
      ),
    ).resolves.toBe(false);
  });

  it("returns false after a 5s timeout when the fetch never resolves", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));

    const pending = sendGuestbookEmbed(
      WEBHOOK_URL,
      { id: 1, name: "a", message: "b", ipHash: "c" },
      fetchFn,
    );
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBe(false);
  });
});

describe("POST /api/guestbook discord notification", () => {
  it("notifies with the new entry id and still returns 201", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));
    const { app, secret } = buildApp({ webhookUrl: WEBHOOK_URL, fetchFn });

    const res = await postGuestbook(app, validBody(secret));

    expect(res.status).toBe(201);
    const { entry } = (await res.json()) as { entry: { id: number } };
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const { url, init } = parsedBody(fetchFn);
    expect(url).toBe(WEBHOOK_URL);
    expect(init.body as string).toContain(`Guestbook entry #${entry.id}`);
  });

  it("returns 201 even when delivery fails", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500));
    const { app, secret } = buildApp({ webhookUrl: WEBHOOK_URL, fetchFn });

    const res = await postGuestbook(app, validBody(secret));

    expect(res.status).toBe(201);
  });

  it("returns 201 immediately when the webhook never resolves", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const { app, secret } = buildApp({ webhookUrl: WEBHOOK_URL, fetchFn });

    const res = await postGuestbook(app, validBody(secret));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { entry: { message: string } };
    expect(body.entry.message).toBe("hello there");
  });

  it("does not notify when no webhook is configured", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));
    const { app, secret } = buildApp({ webhookUrl: null, fetchFn });

    await postGuestbook(app, validBody(secret));

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not notify on the honeypot fake-success path", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));
    const { app, secret } = buildApp({ webhookUrl: WEBHOOK_URL, fetchFn });

    const res = await postGuestbook(
      app,
      validBody(secret, { website: "spam-bot" }),
    );

    expect(res.status).toBe(201);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not notify a blocked ip's fake success", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));
    const { app, db, secret } = buildApp({ webhookUrl: WEBHOOK_URL, fetchFn });
    db.prepare("INSERT INTO blocklist (ip_hash, ts) VALUES (?, ?)").run(
      hashIp(secret, "9.9.9.9"),
      FIXED_NOW,
    );

    const res = await postGuestbook(app, validBody(secret), { ip: "9.9.9.9" });

    expect(res.status).toBe(201);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("notifies only the accepted sign when the daily cap rejects the second", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));
    const { app, secret } = buildApp({
      webhookUrl: WEBHOOK_URL,
      fetchFn,
      perIpCap: 1,
    });

    const first = await postGuestbook(app, validBody(secret));
    const second = await postGuestbook(app, validBody(secret));

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
