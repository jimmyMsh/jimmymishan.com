import { afterEach, describe, expect, it, vi } from "vitest";
import { sendContactEmbed } from "../src/discord.js";
import { contactRoutes } from "../src/routes/contact.js";
import { DailyCaps, mintToken, WriteCounters } from "../src/writes/gate.js";

const SECRET = "contact-secret";
const FIXED_NOW = 1_700_000_000;
const WEBHOOK_URL = "https://discord.com/api/webhooks/123456/token-abc";

function jsonResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

function parsedBody(fetchFn: ReturnType<typeof vi.fn>): {
  url: unknown;
  init: RequestInit | undefined;
  body: {
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

describe("sendContactEmbed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the pinned discord payload shape and returns true on 204", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));

    const ok = await sendContactEmbed(
      WEBHOOK_URL,
      { message: "hello there", from: "vera" },
      fetchFn,
    );

    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const { url, init, body } = parsedBody(fetchFn);
    expect(url).toBe(WEBHOOK_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toMatch(
      /application\/json/i,
    );
    expect(body).toEqual({
      embeds: [
        {
          title: "Contact message",
          description: "hello there",
          fields: [{ name: "From", value: "vera" }],
          timestamp: expect.any(String),
        },
      ],
      allowed_mentions: { parse: [] },
    });
    expect(Number.isNaN(Date.parse(body.embeds[0].timestamp))).toBe(false);
  });

  it("uses '(not given)' as the From field value when from is null", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(204));

    await sendContactEmbed(WEBHOOK_URL, { message: "hi", from: null }, fetchFn);

    const { body } = parsedBody(fetchFn);
    expect(body.embeds[0].fields[0]).toEqual({
      name: "From",
      value: "(not given)",
    });
  });

  it("returns false on a non-2xx response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500));

    await expect(
      sendContactEmbed(WEBHOOK_URL, { message: "hi", from: null }, fetchFn),
    ).resolves.toBe(false);
  });

  it("returns false when fetch throws a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      sendContactEmbed(WEBHOOK_URL, { message: "hi", from: null }, fetchFn),
    ).resolves.toBe(false);
  });

  it("returns false after a 5s timeout when the fetch never resolves", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));

    const pending = sendContactEmbed(
      WEBHOOK_URL,
      { message: "hi", from: null },
      fetchFn,
    );
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBe(false);
  });
});

function buildApp(opts?: {
  webhookUrl?: string | null;
  secret?: string;
  now?: () => number;
  perIpCap?: number;
  globalCap?: number;
  fetchFn?: typeof fetch;
}) {
  const secret = opts?.secret ?? SECRET;
  const caps = new DailyCaps(opts?.perIpCap ?? 100, opts?.globalCap ?? 1000);
  const counters = new WriteCounters();
  const fetchFn: typeof fetch =
    opts?.fetchFn ?? vi.fn(async () => jsonResponse(204));
  const app = contactRoutes({
    webhookUrl: opts?.webhookUrl === undefined ? WEBHOOK_URL : opts.webhookUrl,
    secret,
    caps,
    counters,
    fetchFn,
    nowSec: opts?.now ?? (() => FIXED_NOW),
  });
  return { app, caps, counters, secret, fetchFn };
}

function validBody(
  secret: string,
  overrides?: Partial<{
    from: string;
    message: string;
    token: string;
    website: string;
  }>,
) {
  return {
    from: "vera",
    message: "hello there",
    token: mintToken(secret, FIXED_NOW),
    ...overrides,
  };
}

function postContact(
  app: ReturnType<typeof buildApp>["app"],
  body: Record<string, unknown> | undefined,
  opts?: { rawBody?: string; contentType?: string },
) {
  const headers: Record<string, string> = {
    "content-type": opts?.contentType ?? "application/json",
  };
  return app.request("/api/contact", {
    method: "POST",
    headers,
    body: opts?.rawBody ?? JSON.stringify(body),
  });
}

describe("POST /api/contact", () => {
  it("returns 503 disabled before any fetch when the webhook is unset", async () => {
    const { app, counters, secret, fetchFn } = buildApp({ webhookUrl: null });

    const res = await postContact(app, validBody(secret));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "disabled" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "disabled", count: 1 },
      ]),
    );
  });

  it("rejects an oversized body before parsing, ahead of the token check", async () => {
    const { app, counters, secret } = buildApp();
    const oversized = JSON.stringify(
      validBody(secret, { message: "a".repeat(9000) }),
    );
    expect(oversized.length).toBeGreaterThan(8192);

    const res = await postContact(app, undefined, { rawBody: oversized });
    const body = (await res.json()) as { error: string; field?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid");
    expect(body.field).toBeUndefined();
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects malformed JSON", async () => {
    const { app, counters } = buildApp();

    const res = await postContact(app, undefined, { rawBody: "{not json" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects a non-JSON content-type even with an otherwise-valid body", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postContact(app, validBody(secret), {
      contentType: "text/plain",
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("accepts a content-type with a charset suffix", async () => {
    const { app, secret } = buildApp();

    const res = await postContact(app, validBody(secret), {
      contentType: "application/json; charset=utf-8",
    });

    expect(res.status).toBe(200);
  });

  it("rejects a missing or invalid token with field: token", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postContact(app, validBody(secret, { token: "garbage" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid", field: "token" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "token", count: 1 },
      ]),
    );
  });

  it("returns a fake sent:true for a honeypot hit and never calls fetch", async () => {
    const { app, counters, secret, fetchFn } = buildApp();

    const res = await postContact(
      app,
      validBody(secret, { website: "https://spam.example" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ sent: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "honeypot", count: 1 },
      ]),
    );
  });

  it("rejects an empty message", async () => {
    const { app, counters, secret } = buildApp();

    const res = await postContact(app, validBody(secret, { message: "  " }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "message" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "invalid", count: 1 },
      ]),
    );
  });

  it("rejects a 1001-character message", async () => {
    const { app, secret } = buildApp();

    const res = await postContact(
      app,
      validBody(secret, { message: "a".repeat(1001) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "message" });
  });

  it("accepts a 1000-character message", async () => {
    const { app, secret } = buildApp();

    const res = await postContact(
      app,
      validBody(secret, { message: "a".repeat(1000) }),
    );

    expect(res.status).toBe(200);
  });

  it("rejects a from longer than 100 characters", async () => {
    const { app, secret } = buildApp();

    const res = await postContact(
      app,
      validBody(secret, { from: "n".repeat(101) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "from" });
  });

  it("defaults a missing from to null without rejecting", async () => {
    const { app, secret } = buildApp();
    const { from: _from, ...withoutFrom } = validBody(secret);

    const res = await postContact(app, withoutFrom);

    expect(res.status).toBe(200);
  });

  it("accepts a message containing a link — no URL rejection for contact", async () => {
    const { app, secret } = buildApp();

    const res = await postContact(
      app,
      validBody(secret, { message: "see https://example.com for more" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it("enforces the per-ip daily cap and returns rate_limited", async () => {
    const { app, counters, secret } = buildApp({ perIpCap: 1 });

    const first = await postContact(app, validBody(secret));
    const second = await postContact(
      app,
      validBody(secret, { message: "second message" }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "rejected", reason: "rate", count: 1 },
      ]),
    );
  });

  it("sends the message and returns sent:true on a successful delivery", async () => {
    const { app, counters, secret, fetchFn } = buildApp();

    const res = await postContact(app, validBody(secret));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ sent: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "contact", kind: "accepted", count: 1 },
      ]),
    );
  });

  it("returns 502 delivery_failed when discord responds non-2xx", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500));
    const { app, secret } = buildApp({ fetchFn });

    const res = await postContact(app, validBody(secret));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "delivery_failed" });
  });

  it("returns 502 delivery_failed when the fetch throws a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { app, secret } = buildApp({ fetchFn });

    const res = await postContact(app, validBody(secret));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "delivery_failed" });
  });

  it("returns 502 delivery_failed after a 5s delivery timeout", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const { app, secret } = buildApp({ fetchFn });

    const pending = postContact(app, validBody(secret));
    await vi.advanceTimersByTimeAsync(5000);

    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "delivery_failed" });
    vi.useRealTimers();
  });
});
