import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runGuestbookCli } from "../src/cli.js";
import { openGuestbookDb } from "../src/db.js";

function seedEntry(
  db: DatabaseSync,
  row: {
    name: string;
    message: string;
    ts: number;
    ipHash: string;
    hidden?: number;
  },
): number {
  const result = db
    .prepare(
      "INSERT INTO entries (name, message, ts, ip_hash, hidden) VALUES (?, ?, ?, ?, ?)",
    )
    .run(row.name, row.message, row.ts, row.ipHash, row.hidden ?? 0);
  return Number(result.lastInsertRowid);
}

function visibleIds(db: DatabaseSync): number[] {
  return (
    db
      .prepare("SELECT id FROM entries WHERE hidden = 0 ORDER BY id DESC")
      .all() as Array<{ id: number }>
  ).map((row) => row.id);
}

function capture(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line: string) => lines.push(line), lines };
}

describe("runGuestbookCli list", () => {
  it("lists entries newest-first with all columns", () => {
    const db = openGuestbookDb(":memory:");
    seedEntry(db, {
      name: "vera",
      message: "hello there",
      ts: 1000,
      ipHash: "hash-a",
    });
    seedEntry(db, {
      name: "sam",
      message: "second message",
      ts: 2000,
      ipHash: "hash-b",
      hidden: 1,
    });

    const { out, lines } = capture();
    const code = runGuestbookCli(db, ["list"], out);

    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    // newest (id 2, hidden) first
    expect(lines[0]).toContain("2");
    expect(lines[0]).toContain("sam");
    expect(lines[0]).toContain("hash-b");
    expect(lines[0]).toContain("second message");
    expect(lines[0]).toContain(new Date(2000 * 1000).toISOString());
    expect(lines[0]).toMatch(/hidden/i);

    expect(lines[1]).toContain("1");
    expect(lines[1]).toContain("vera");
    expect(lines[1]).toContain("hash-a");
    expect(lines[1]).toContain("hello there");
    expect(lines[1]).toMatch(/visible/i);
  });

  it("truncates the message to its first 60 characters", () => {
    const db = openGuestbookDb(":memory:");
    const long = "x".repeat(100);
    seedEntry(db, { name: "vera", message: long, ts: 1000, ipHash: "hash-a" });

    const { out, lines } = capture();
    runGuestbookCli(db, ["list"], out);

    expect(lines[0]).toContain(long.slice(0, 60));
    expect(lines[0]).not.toContain(long);
  });

  it("defaults to the 20 newest entries", () => {
    const db = openGuestbookDb(":memory:");
    for (let i = 0; i < 25; i++) {
      seedEntry(db, {
        name: `n${i}`,
        message: `m${i}`,
        ts: 1000 + i,
        ipHash: `h${i}`,
      });
    }

    const { out, lines } = capture();
    const code = runGuestbookCli(db, ["list"], out);

    expect(code).toBe(0);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain("n24");
    expect(lines[19]).toContain("n5");
  });

  it("respects an explicit n", () => {
    const db = openGuestbookDb(":memory:");
    for (let i = 0; i < 5; i++) {
      seedEntry(db, {
        name: `n${i}`,
        message: `m${i}`,
        ts: 1000 + i,
        ipHash: `h${i}`,
      });
    }

    const { out, lines } = capture();
    const code = runGuestbookCli(db, ["list", "2"], out);

    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("n4");
    expect(lines[1]).toContain("n3");
  });
});

describe("runGuestbookCli hide/unhide", () => {
  it("hides an entry so it disappears from the public GET query shape", () => {
    const db = openGuestbookDb(":memory:");
    const id = seedEntry(db, {
      name: "vera",
      message: "hi",
      ts: 1000,
      ipHash: "hash-a",
    });

    const { out } = capture();
    const code = runGuestbookCli(db, ["hide", String(id)], out);

    expect(code).toBe(0);
    expect(visibleIds(db)).not.toContain(id);
  });

  it("unhides a previously hidden entry", () => {
    const db = openGuestbookDb(":memory:");
    const id = seedEntry(db, {
      name: "vera",
      message: "hi",
      ts: 1000,
      ipHash: "hash-a",
      hidden: 1,
    });

    const { out } = capture();
    const code = runGuestbookCli(db, ["unhide", String(id)], out);

    expect(code).toBe(0);
    expect(visibleIds(db)).toContain(id);
  });

  it("reports not found for a hide of a nonexistent id", () => {
    const db = openGuestbookDb(":memory:");

    const { out, lines } = capture();
    const code = runGuestbookCli(db, ["hide", "999"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("not found");
  });
});

describe("runGuestbookCli delete", () => {
  it("removes the row", () => {
    const db = openGuestbookDb(":memory:");
    const id = seedEntry(db, {
      name: "vera",
      message: "hi",
      ts: 1000,
      ipHash: "hash-a",
    });

    const { out } = capture();
    const code = runGuestbookCli(db, ["delete", String(id)], out);

    expect(code).toBe(0);
    const row = db.prepare("SELECT id FROM entries WHERE id = ?").get(id);
    expect(row).toBeUndefined();
  });

  it("reports not found for a delete of a nonexistent id", () => {
    const db = openGuestbookDb(":memory:");

    const { out, lines } = capture();
    const code = runGuestbookCli(db, ["delete", "999"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("not found");
  });
});

describe("runGuestbookCli block/unblock", () => {
  it("inserts into the blocklist and is idempotent", () => {
    const db = openGuestbookDb(":memory:");
    const { out } = capture();

    expect(runGuestbookCli(db, ["block", "hash-x"], out)).toBe(0);
    expect(runGuestbookCli(db, ["block", "hash-x"], out)).toBe(0);

    const rows = db
      .prepare("SELECT ip_hash FROM blocklist WHERE ip_hash = ?")
      .all("hash-x");
    expect(rows).toHaveLength(1);
  });

  it("removes a blocked hash", () => {
    const db = openGuestbookDb(":memory:");
    const { out } = capture();
    runGuestbookCli(db, ["block", "hash-x"], out);

    const code = runGuestbookCli(db, ["unblock", "hash-x"], out);

    expect(code).toBe(0);
    const row = db
      .prepare("SELECT ip_hash FROM blocklist WHERE ip_hash = ?")
      .get("hash-x");
    expect(row).toBeUndefined();
  });
});

describe("runGuestbookCli usage errors", () => {
  it("prints usage and exits 1 for an unknown command", () => {
    const db = openGuestbookDb(":memory:");
    const { out, lines } = capture();

    const code = runGuestbookCli(db, ["bogus"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage:/i);
  });

  it("prints usage and exits 1 for a missing hide id", () => {
    const db = openGuestbookDb(":memory:");
    const { out, lines } = capture();

    const code = runGuestbookCli(db, ["hide"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage:/i);
  });

  it("prints usage and exits 1 for a non-numeric id", () => {
    const db = openGuestbookDb(":memory:");
    const { out, lines } = capture();

    const code = runGuestbookCli(db, ["hide", "abc"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage:/i);
  });

  it("prints usage and exits 1 for a non-numeric n on list", () => {
    const db = openGuestbookDb(":memory:");
    const { out, lines } = capture();

    const code = runGuestbookCli(db, ["list", "abc"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage:/i);
  });

  it("prints usage and exits 1 for a missing block ip_hash", () => {
    const db = openGuestbookDb(":memory:");
    const { out, lines } = capture();

    const code = runGuestbookCli(db, ["block"], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage:/i);
  });

  it("prints usage and exits 1 with no command at all", () => {
    const db = openGuestbookDb(":memory:");
    const { out, lines } = capture();

    const code = runGuestbookCli(db, [], out);

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage:/i);
  });
});

describe("module import guard", () => {
  it("does not run main() on import", async () => {
    // main() opens /data/guestbook.db, which does not exist outside the
    // container; if the guard were missing this import would throw.
    await expect(import("../src/cli.js")).resolves.toBeDefined();
  });
});
