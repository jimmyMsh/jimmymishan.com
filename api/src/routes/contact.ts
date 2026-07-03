import { Hono } from "hono";
import { sendContactEmbed } from "../discord.js";
import {
  cleanText,
  clientIp,
  type DailyCaps,
  hashIp,
  verifyToken,
  type WriteCounters,
} from "../writes/gate.js";

export interface ContactDeps {
  webhookUrl: string | null;
  secret: string;
  caps: DailyCaps;
  counters: WriteCounters;
  fetchFn?: typeof fetch;
  nowSec?: () => number;
}

const MAX_BODY_BYTES = 8192;
const MAX_MESSAGE_LEN = 1000;
const MAX_FROM_LEN = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function resolveMessage(obj: Record<string, unknown>): string {
  return cleanText(extractString(obj, "message") ?? "");
}

// Unlike guestbook's name, an absent/blank `from` has no persona default —
// it's genuinely optional, so it stays null straight through to Discord.
function resolveFrom(obj: Record<string, unknown>): string | null {
  const cleaned = cleanText(extractString(obj, "from") ?? "");
  return cleaned.length > 0 ? cleaned : null;
}

function utcDay(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

export function contactRoutes(deps: ContactDeps): Hono {
  const { webhookUrl, secret, caps, counters } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();

  app.post("/api/contact", async (c) => {
    if (webhookUrl === null) {
      counters.rejected("contact", "disabled");
      return c.json({ error: "disabled" }, 503);
    }

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      counters.rejected("contact", "invalid");
      return c.json({ error: "invalid" }, 400);
    }

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      counters.rejected("contact", "invalid");
      return c.json({ error: "invalid" }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed)) {
      counters.rejected("contact", "invalid");
      return c.json({ error: "invalid" }, 400);
    }

    const nowSecVal = nowSec();

    const token = extractString(parsed, "token");
    if (!verifyToken(secret, token, nowSecVal)) {
      counters.rejected("contact", "token");
      return c.json({ error: "invalid", field: "token" }, 400);
    }

    const ip = clientIp(c.req.header("X-Real-IP"));
    const ipHash = hashIp(secret, ip);
    const message = resolveMessage(parsed);
    const from = resolveFrom(parsed);

    const website = extractString(parsed, "website");
    if (website !== undefined && website.length > 0) {
      counters.rejected("contact", "honeypot");
      return c.json({ sent: true }, 200);
    }

    if (message.length < 1 || message.length > MAX_MESSAGE_LEN) {
      counters.rejected("contact", "invalid");
      return c.json({ error: "invalid", field: "message" }, 400);
    }
    if (from !== null && from.length > MAX_FROM_LEN) {
      counters.rejected("contact", "invalid");
      return c.json({ error: "invalid", field: "from" }, 400);
    }

    if (!caps.allow(ipHash, utcDay(nowSecVal))) {
      counters.rejected("contact", "rate");
      return c.json({ error: "rate_limited" }, 429);
    }

    const delivered = await sendContactEmbed(
      webhookUrl,
      { message, from },
      fetchFn,
    );
    if (!delivered) {
      return c.json({ error: "delivery_failed" }, 502);
    }

    counters.accepted("contact");
    return c.json({ sent: true }, 200);
  });

  return app;
}
