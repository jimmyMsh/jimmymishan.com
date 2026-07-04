import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { openGuestbookDb } from "./db.js";

const DEFAULT_LIST_N = 20;

const USAGE = [
  "usage: guestbook <command> [args]",
  "commands:",
  "  list [n=20]",
  "  hide <id>",
  "  unhide <id>",
  "  delete <id>",
  "  block <ip_hash>",
  "  unblock <ip_hash>",
];

// `type` (not `interface`) so this compares structurally against the SQLite
// row shape when cast below (matches routes/guestbook.ts's EntryRow).
type ModerationRow = {
  id: number;
  name: string;
  message: string;
  ts: number;
  ip_hash: string;
  hidden: number;
};

function printUsage(out: (line: string) => void): number {
  for (const line of USAGE) out(line);
  return 1;
}

// Accepts only unsigned integer literals so "3.5", "-1" and "abc" all fall
// through to the usage path rather than silently coercing to NaN/0.
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function formatRow(row: ModerationRow): string {
  const iso = new Date(row.ts * 1000).toISOString();
  const hiddenFlag = row.hidden ? "hidden" : "visible";
  return `${row.id} · ${iso} · ${row.name} · ${row.ip_hash} · ${hiddenFlag} · ${row.message.slice(0, 60)}`;
}

function runList(
  db: DatabaseSync,
  rest: string[],
  out: (line: string) => void,
): number {
  let n = DEFAULT_LIST_N;
  if (rest.length > 0) {
    const parsed = parsePositiveInt(rest[0]);
    if (parsed === undefined) return printUsage(out);
    n = parsed;
  }
  const rows = db
    .prepare(
      "SELECT id, name, message, ts, ip_hash, hidden FROM entries ORDER BY id DESC LIMIT ?",
    )
    .all(n) as ModerationRow[];
  for (const row of rows) out(formatRow(row));
  return 0;
}

function runSetHidden(
  db: DatabaseSync,
  rest: string[],
  out: (line: string) => void,
  hidden: 0 | 1,
): number {
  const id = parsePositiveInt(rest[0]);
  if (id === undefined) return printUsage(out);
  const result = db
    .prepare("UPDATE entries SET hidden = ? WHERE id = ?")
    .run(hidden, id);
  if (result.changes === 0) {
    out("not found");
    return 1;
  }
  out(`${hidden ? "hidden" : "unhidden"} ${id}`);
  return 0;
}

function runDelete(
  db: DatabaseSync,
  rest: string[],
  out: (line: string) => void,
): number {
  const id = parsePositiveInt(rest[0]);
  if (id === undefined) return printUsage(out);
  const result = db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  if (result.changes === 0) {
    out("not found");
    return 1;
  }
  out(`deleted ${id}`);
  return 0;
}

// Blocklist entries are keyed on ip_hash, not a numeric id, so there is no
// "not found" case here: block is required to be idempotent (PRIMARY KEY),
// and unblock mirrors that — removing an absent hash is a no-op, not an error.
function runBlock(
  db: DatabaseSync,
  rest: string[],
  out: (line: string) => void,
): number {
  const ipHash = rest[0];
  if (!ipHash) return printUsage(out);
  db.prepare("INSERT OR IGNORE INTO blocklist (ip_hash, ts) VALUES (?, ?)").run(
    ipHash,
    Math.floor(Date.now() / 1000),
  );
  out(`blocked ${ipHash}`);
  return 0;
}

function runUnblock(
  db: DatabaseSync,
  rest: string[],
  out: (line: string) => void,
): number {
  const ipHash = rest[0];
  if (!ipHash) return printUsage(out);
  db.prepare("DELETE FROM blocklist WHERE ip_hash = ?").run(ipHash);
  out(`unblocked ${ipHash}`);
  return 0;
}

export function runGuestbookCli(
  db: DatabaseSync,
  argv: string[],
  out: (line: string) => void,
): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "list":
      return runList(db, rest, out);
    case "hide":
      return runSetHidden(db, rest, out, 1);
    case "unhide":
      return runSetHidden(db, rest, out, 0);
    case "delete":
      return runDelete(db, rest, out);
    case "block":
      return runBlock(db, rest, out);
    case "unblock":
      return runUnblock(db, rest, out);
    default:
      return printUsage(out);
  }
}

function main(): void {
  const [group, ...rest] = process.argv.slice(2);
  if (group !== "guestbook") {
    for (const line of USAGE) console.log(line);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(process.env);
  const db = openGuestbookDb(join(config.dataDir, "guestbook.db"));
  const code = runGuestbookCli(db, rest, (line) => console.log(line));
  db.close();
  process.exitCode = code;
}

// `main()` must only run when this file is the process entrypoint (docker
// compose exec ... node api/dist/cli.js guestbook <cmd>), never on import —
// tests import the module to exercise runGuestbookCli directly.
if (import.meta.main) main();
