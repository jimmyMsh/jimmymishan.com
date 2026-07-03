import { DatabaseSync } from "node:sqlite";

const DEPLOYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS deploys (
  id INTEGER PRIMARY KEY,
  sha TEXT NOT NULL,
  tag TEXT,
  status TEXT NOT NULL,
  actor TEXT,
  ts INTEGER NOT NULL,
  UNIQUE(sha, ts)
)`;

const SLO_SCHEMA = `
CREATE TABLE IF NOT EXISTS probes (
  ts INTEGER PRIMARY KEY,
  ok INTEGER NOT NULL,
  latency_ms INTEGER
);
CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY,
  total INTEGER,
  ok INTEGER,
  p50_ms INTEGER,
  p95_ms INTEGER,
  p99_ms INTEGER
)`;

const GUESTBOOK_SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blocklist (
  ip_hash TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
)`;

// WAL needs a file to keep its companion -wal/-shm files in; :memory: databases
// have no file and silently ignore the pragma.
function enableWalIfFileBacked(db: DatabaseSync, path: string): void {
  if (path === ":memory:") return;
  db.exec("PRAGMA journal_mode = WAL");
}

export function openDeploysDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  enableWalIfFileBacked(db, path);
  db.exec(DEPLOYS_SCHEMA);
  return db;
}

export function openSloDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  enableWalIfFileBacked(db, path);
  db.exec(SLO_SCHEMA);
  return db;
}

export function openGuestbookDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  enableWalIfFileBacked(db, path);
  db.exec(GUESTBOOK_SCHEMA);
  return db;
}
