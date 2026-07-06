import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { sendGuestbookEmbed } from "../discord.js";
import {
  cleanText,
  clientIp,
  containsUrl,
  type DailyCaps,
  hashIp,
  mintToken,
  verifyToken,
  type WriteCounters,
} from "../writes/gate.js";

export interface GuestbookDeps {
  db: DatabaseSync;
  secret: string;
  enabled: boolean;
  caps: DailyCaps;
  counters: WriteCounters;
  webhookUrl: string | null;
  fetchFn?: typeof fetch;
  nowSec?: () => number;
}

const MAX_BODY_BYTES = 8192;
const MAX_MESSAGE_LEN = 280;
const MAX_NAME_LEN = 32;
const DEFAULT_NAME = "anonymous";
const RECENT_LIMIT = 100;

interface PublicEntry {
  id: number;
  name: string;
  message: string;
  ts: number;
}

// `type` (not `interface`) so this compares structurally against the SQLite
// row shape when cast below.
type EntryRow = {
  id: number;
  name: string;
  message: string;
  ts: number;
};

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

// Shared by the honeypot/blocklist fake-success paths and the real field
// validation below, so both agree on what "the submitted name/message" is.
function resolveMessage(obj: Record<string, unknown>): string {
  return cleanText(extractString(obj, "message") ?? "");
}

function resolveName(obj: Record<string, unknown>): string {
  const cleaned = cleanText(extractString(obj, "name") ?? "");
  return cleaned.length > 0 ? cleaned : DEFAULT_NAME;
}

function utcDay(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

export function guestbookRoutes(deps: GuestbookDeps): Hono {
  const { db, secret, caps, counters, webhookUrl } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();

  const selectVisible = db.prepare(
    "SELECT id, name, message, ts FROM entries WHERE hidden = 0 ORDER BY id DESC LIMIT ?",
  );
  const selectBlocked = db.prepare("SELECT 1 FROM blocklist WHERE ip_hash = ?");
  const insertEntry = db.prepare(
    "INSERT INTO entries (name, message, ts, ip_hash) VALUES (?, ?, ?, ?)",
  );

  app.get("/api/guestbook", (c) => {
    const rows = selectVisible.all(RECENT_LIMIT) as EntryRow[];
    const entries: PublicEntry[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      message: row.message,
      ts: row.ts,
    }));
    return c.json({ entries, token: mintToken(secret, nowSec()) });
  });

  app.post("/api/guestbook", async (c) => {
    if (!deps.enabled) {
      counters.rejected("guestbook", "disabled");
      return c.json({ error: "disabled" }, 503);
    }

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      counters.rejected("guestbook", "invalid");
      return c.json({ error: "invalid" }, 400);
    }

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      counters.rejected("guestbook", "invalid");
      return c.json({ error: "invalid" }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed)) {
      counters.rejected("guestbook", "invalid");
      return c.json({ error: "invalid" }, 400);
    }

    const nowSecVal = nowSec();

    const token = extractString(parsed, "token");
    if (!verifyToken(secret, token, nowSecVal)) {
      counters.rejected("guestbook", "token");
      return c.json({ error: "invalid", field: "token" }, 400);
    }

    const ip = clientIp(c.req.header("X-Real-IP"));
    const ipHash = hashIp(secret, ip);
    const message = resolveMessage(parsed);
    const name = resolveName(parsed);

    const website = extractString(parsed, "website");
    if (website !== undefined && website.length > 0) {
      counters.rejected("guestbook", "honeypot");
      return c.json({ entry: { id: 0, name, message, ts: nowSecVal } }, 201);
    }

    if (selectBlocked.get(ipHash) !== undefined) {
      counters.rejected("guestbook", "blocked");
      return c.json({ entry: { id: 0, name, message, ts: nowSecVal } }, 201);
    }

    if (message.length < 1 || message.length > MAX_MESSAGE_LEN) {
      counters.rejected("guestbook", "invalid");
      return c.json({ error: "invalid", field: "message" }, 400);
    }
    if (name.length > MAX_NAME_LEN) {
      counters.rejected("guestbook", "invalid");
      return c.json({ error: "invalid", field: "name" }, 400);
    }
    if (containsUrl(message) || containsUrl(name)) {
      counters.rejected("guestbook", "invalid");
      return c.json({ error: "invalid", field: "url" }, 400);
    }

    if (!caps.allow(ipHash, utcDay(nowSecVal))) {
      counters.rejected("guestbook", "rate");
      return c.json({ error: "rate_limited" }, 429);
    }

    const result = insertEntry.run(name, message, nowSecVal, ipHash);
    counters.accepted("guestbook");
    const id = Number(result.lastInsertRowid);
    if (webhookUrl !== null) {
      // The sign is the product; the notification is a side channel that must
      // never delay or fail the response — so no await. sendGuestbookEmbed is
      // contracted never to reject; the .catch is defensive insurance so a
      // future contract slip can't crash this single-instance process.
      void sendGuestbookEmbed(
        webhookUrl,
        { id, name, message, ipHash },
        fetchFn,
      )
        .then((ok) => {
          if (!ok) console.error(`guestbook notify failed for entry ${id}`);
        })
        .catch(() => {});
    }
    return c.json({ entry: { id, name, message, ts: nowSecVal } }, 201);
  });

  return app;
}
