import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { SseHub } from "../sse.js";

export interface DeployRecord {
  sha: string;
  tag: string | null;
  status: "ok" | "failed";
  actor: string | null;
  at: number;
}

export interface DeploysRouteDeps {
  db: DatabaseSync;
  secret: string | null;
  hub: SseHub;
  now?: () => number;
}

const SIGNATURE_PREFIX = "sha256=";
const FRESHNESS_WINDOW_SEC = 300;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface WebhookBody {
  sha: string;
  tag?: string;
  status: "ok" | "failed";
  actor?: string;
  ts: number;
}

function isWebhookBody(value: unknown): value is WebhookBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sha === "string" &&
    v.sha.length > 0 &&
    (v.status === "ok" || v.status === "failed") &&
    typeof v.ts === "number" &&
    Number.isFinite(v.ts) &&
    (v.tag === undefined || typeof v.tag === "string") &&
    (v.actor === undefined || typeof v.actor === "string")
  );
}

// Constant-time compare requires equal-length inputs (it throws otherwise),
// so a length mismatch is treated as a mismatch rather than an error.
function verifySignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): boolean {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false;

  const provided = Buffer.from(header.slice(SIGNATURE_PREFIX.length), "hex");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(rawBody).digest("hex"),
    "hex",
  );
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// `type` (not `interface`) so this compares structurally against the SQLite
// row shape (Record<string, SQLOutputValue>) when cast below.
type DeployRow = {
  sha: string;
  tag: string | null;
  status: string;
  actor: string | null;
  ts: number;
};

function toRecord(row: DeployRow): DeployRecord {
  return {
    sha: row.sha,
    tag: row.tag,
    status: row.status === "failed" ? "failed" : "ok",
    actor: row.actor,
    at: row.ts,
  };
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

export function deploysRoutes(deps: DeploysRouteDeps): Hono {
  const { db, secret, hub } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();

  const insert = db.prepare(
    "INSERT OR IGNORE INTO deploys (sha, tag, status, actor, ts) VALUES (?, ?, ?, ?, ?)",
  );
  const selectRecent = db.prepare(
    "SELECT sha, tag, status, actor, ts FROM deploys ORDER BY ts DESC LIMIT ?",
  );

  app.get("/api/deploys", (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const rows = selectRecent.all(limit) as DeployRow[];
    return c.json({ deploys: rows.map(toRecord) });
  });

  app.post("/api/deploys/webhook", async (c) => {
    if (secret === null) return c.text("", 503);

    const rawBody = await c.req.text();
    const signature = c.req.header("X-Deploy-Signature");
    if (!verifySignature(secret, rawBody, signature)) {
      return c.text("", 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }

    // The freshness check only applies once a numeric ts is extractable;
    // anything else falls through to the full shape check below, which
    // reports it as a 400 rather than misreporting it as stale.
    const candidateTs =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).ts
        : undefined;
    if (typeof candidateTs === "number" && Number.isFinite(candidateTs)) {
      if (Math.abs(now() - candidateTs) > FRESHNESS_WINDOW_SEC) {
        return c.text("", 401);
      }
    }

    if (!isWebhookBody(parsed)) return c.text("", 400);

    const result = insert.run(
      parsed.sha,
      parsed.tag ?? null,
      parsed.status,
      parsed.actor ?? null,
      parsed.ts,
    );
    const recorded = Number(result.changes) > 0;

    if (recorded) {
      hub.broadcast("deploy", {
        sha: parsed.sha,
        tag: parsed.tag ?? null,
        status: parsed.status,
        at: parsed.ts,
      });
    }

    return c.json({ recorded });
  });

  return app;
}
