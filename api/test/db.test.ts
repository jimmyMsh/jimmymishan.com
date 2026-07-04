import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDeploysDb, openGuestbookDb, openSloDb } from "../src/db.js";

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
}

describe("openDeploysDb", () => {
  it("creates the deploys table", () => {
    const db = openDeploysDb(":memory:");
    expect(tableNames(db)).toEqual(["deploys"]);
  });

  it("is idempotent when opened twice against the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploys-db-"));
    const path = join(dir, "deploys.db");

    const first = openDeploysDb(path);
    first.close();

    expect(() => {
      const second = openDeploysDb(path);
      second.close();
    }).not.toThrow();
  });

  it("makes a replayed insert a no-op via UNIQUE(sha, ts)", () => {
    const db = openDeploysDb(":memory:");
    const insert = db.prepare(
      "INSERT OR IGNORE INTO deploys (sha, tag, status, actor, ts) VALUES (?, ?, ?, ?, ?)",
    );

    const first = insert.run("abc123", "v1", "ok", "jimmy", 1000);
    expect(first.changes).toBe(1);

    const second = insert.run("abc123", "v1", "ok", "jimmy", 1000);
    expect(second.changes).toBe(0);
  });

  it("enables WAL journal mode on a file-backed database", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploys-db-"));
    const path = join(dir, "deploys.db");

    const db = openDeploysDb(path);
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(String(row.journal_mode).toLowerCase()).toBe("wal");
  });
});

describe("openSloDb", () => {
  it("creates the probes and daily tables", () => {
    const db = openSloDb(":memory:");
    expect(tableNames(db)).toEqual(["daily", "probes"]);
  });
});

describe("openGuestbookDb", () => {
  it("creates the entries and blocklist tables", () => {
    const db = openGuestbookDb(":memory:");
    expect(tableNames(db)).toEqual(["blocklist", "entries"]);
  });

  it("is idempotent when opened twice against the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "guestbook-db-"));
    const path = join(dir, "guestbook.db");

    const first = openGuestbookDb(path);
    first.close();

    expect(() => {
      const second = openGuestbookDb(path);
      second.close();
    }).not.toThrow();
  });

  it("enables WAL journal mode on a file-backed database", () => {
    const dir = mkdtempSync(join(tmpdir(), "guestbook-db-"));
    const path = join(dir, "guestbook.db");

    const db = openGuestbookDb(path);
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(String(row.journal_mode).toLowerCase()).toBe("wal");
  });
});
