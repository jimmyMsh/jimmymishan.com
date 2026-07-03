import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openSloDb } from "../src/db.js";
import { SloProber } from "../src/slo/probe.js";
import { rollup, sloBlock } from "../src/slo/rollup.js";

function tsUtc(dateTime: string): number {
  return Date.parse(`${dateTime}Z`) / 1000;
}

function insertProbe(
  db: DatabaseSync,
  ts: number,
  ok: number,
  latencyMs: number,
): void {
  db.prepare("INSERT INTO probes (ts, ok, latency_ms) VALUES (?, ?, ?)").run(
    ts,
    ok,
    latencyMs,
  );
}

function probeRows(
  db: DatabaseSync,
): Array<{ ts: number; ok: number; latency_ms: number }> {
  return db
    .prepare("SELECT ts, ok, latency_ms FROM probes ORDER BY ts ASC")
    .all() as Array<{ ts: number; ok: number; latency_ms: number }>;
}

function dailyRows(db: DatabaseSync): Array<{
  day: string;
  total: number;
  ok: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}> {
  return db
    .prepare(
      "SELECT day, total, ok, p50_ms, p95_ms, p99_ms FROM daily ORDER BY day ASC",
    )
    .all() as Array<{
    day: string;
    total: number;
    ok: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
  }>;
}

describe("SloProber", () => {
  it("writes an ok row with the measured latency on a successful probe", async () => {
    const db = openSloDb(":memory:");
    let clock = 1000;
    const fetchFn = vi.fn(async () => {
      clock += 42;
      return new Response("ok", { status: 200 });
    });
    const prober = new SloProber({ db, fetchFn, now: () => clock });

    const onProbe = vi.fn();
    prober.start(onProbe);
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
    prober.stop();

    expect(probeRows(db)).toEqual([{ ts: 1, ok: 1, latency_ms: 42 }]);
    expect(onProbe).toHaveBeenCalledWith({ ts: 1, ok: true, latency_ms: 42 });
  });

  it("writes ok=0 when the response is not ok", async () => {
    const db = openSloDb(":memory:");
    const fetchFn = vi.fn(async () => new Response("err", { status: 503 }));
    const prober = new SloProber({ db, fetchFn, now: () => 2000 });

    const onProbe = vi.fn();
    prober.start(onProbe);
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
    prober.stop();

    expect(probeRows(db)[0]?.ok).toBe(0);
  });

  it("writes ok=0 for a 2xx status that is not exactly 200", async () => {
    const db = openSloDb(":memory:");
    const fetchFn = vi.fn(async () => new Response("created", { status: 201 }));
    const prober = new SloProber({ db, fetchFn, now: () => 4000 });

    const onProbe = vi.fn();
    prober.start(onProbe);
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
    prober.stop();

    expect(probeRows(db)[0]?.ok).toBe(0);
  });

  it("writes ok=0 when fetch throws", async () => {
    const db = openSloDb(":memory:");
    const fetchFn = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const prober = new SloProber({ db, fetchFn, now: () => 3000 });

    const onProbe = vi.fn();
    prober.start(onProbe);
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
    prober.stop();

    expect(probeRows(db)[0]?.ok).toBe(0);
  });

  it("fires an immediate probe on start, before any interval elapses", async () => {
    const db = openSloDb(":memory:");
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const prober = new SloProber({
      db,
      fetchFn,
      intervalMs: 60000,
      now: () => 0,
    });

    const onProbe = vi.fn();
    prober.start(onProbe);
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
    prober.stop();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("probes again every intervalMs while running", async () => {
    vi.useFakeTimers();
    try {
      const db = openSloDb(":memory:");
      const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
      const prober = new SloProber({
        db,
        fetchFn,
        intervalMs: 1000,
        now: () => 0,
      });

      const onProbe = vi.fn();
      prober.start(onProbe);
      await vi.advanceTimersByTimeAsync(0);
      expect(onProbe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(onProbe).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2000);
      expect(onProbe).toHaveBeenCalledTimes(4);

      prober.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops probing once stop() is called", async () => {
    vi.useFakeTimers();
    try {
      const db = openSloDb(":memory:");
      const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
      const prober = new SloProber({
        db,
        fetchFn,
        intervalMs: 1000,
        now: () => 0,
      });

      const onProbe = vi.fn();
      prober.start(onProbe);
      await vi.advanceTimersByTimeAsync(0);
      const callsBeforeStop = onProbe.mock.calls.length;

      prober.stop();
      await vi.advanceTimersByTimeAsync(5000);

      expect(onProbe.mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes the most recent latency, null before the first probe completes", async () => {
    const db = openSloDb(":memory:");
    let clock = 0;
    const fetchFn = vi.fn(async () => {
      clock += 7;
      return new Response(null, { status: 200 });
    });
    const prober = new SloProber({ db, fetchFn, now: () => clock });

    expect(prober.latestLatencyMs()).toBeNull();

    const onProbe = vi.fn();
    prober.start(onProbe);
    await vi.waitFor(() => expect(onProbe).toHaveBeenCalledTimes(1));
    prober.stop();

    expect(prober.latestLatencyMs()).toBe(7);
  });
});

describe("rollup", () => {
  function seedFoldableProbes(db: DatabaseSync): void {
    // 2024-01-01: mixed outcomes, availability 75%.
    insertProbe(db, tsUtc("2024-01-01T01:00:00"), 1, 100);
    insertProbe(db, tsUtc("2024-01-01T07:00:00"), 1, 200);
    insertProbe(db, tsUtc("2024-01-01T13:00:00"), 0, 300);
    insertProbe(db, tsUtc("2024-01-01T19:00:00"), 1, 400);

    // 2024-01-02: all ok.
    insertProbe(db, tsUtc("2024-01-02T00:00:00"), 1, 10);
    insertProbe(db, tsUtc("2024-01-02T06:00:00"), 1, 20);
    insertProbe(db, tsUtc("2024-01-02T12:00:00"), 1, 30);
    insertProbe(db, tsUtc("2024-01-02T18:00:00"), 1, 40);
    insertProbe(db, tsUtc("2024-01-02T23:00:00"), 1, 50);

    // 2024-01-03: within the 48h retention window, must stay raw.
    insertProbe(db, tsUtc("2024-01-03T01:00:00"), 1, 15);
    insertProbe(db, tsUtc("2024-01-03T02:00:00"), 1, 25);
  }

  it("folds fully-elapsed days into daily rows with nearest-rank percentiles", () => {
    const db = openSloDb(":memory:");
    seedFoldableProbes(db);
    const nowSec = tsUtc("2024-01-05T00:00:00");

    rollup(db, nowSec);

    expect(dailyRows(db)).toEqual([
      {
        day: "2024-01-01",
        total: 4,
        ok: 3,
        p50_ms: 200,
        p95_ms: 400,
        p99_ms: 400,
      },
      {
        day: "2024-01-02",
        total: 5,
        ok: 5,
        p50_ms: 30,
        p95_ms: 50,
        p99_ms: 50,
      },
    ]);
    expect(probeRows(db)).toEqual([
      { ts: tsUtc("2024-01-03T01:00:00"), ok: 1, latency_ms: 15 },
      { ts: tsUtc("2024-01-03T02:00:00"), ok: 1, latency_ms: 25 },
    ]);
  });

  it("is idempotent on rerun", () => {
    const db = openSloDb(":memory:");
    seedFoldableProbes(db);
    const nowSec = tsUtc("2024-01-05T00:00:00");

    rollup(db, nowSec);
    const firstDaily = dailyRows(db);
    const firstProbes = probeRows(db);

    rollup(db, nowSec);

    expect(dailyRows(db)).toEqual(firstDaily);
    expect(probeRows(db)).toEqual(firstProbes);
  });
});

describe("sloBlock", () => {
  it("returns null when there is no data at all", () => {
    const db = openSloDb(":memory:");
    expect(sloBlock(db, tsUtc("2024-01-05T00:00:00"))).toBeNull();
  });

  it("combines daily rollups and raw probes into summary percentiles", () => {
    const db = openSloDb(":memory:");
    db.prepare(
      "INSERT INTO daily (day, total, ok, p50_ms, p95_ms, p99_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("2024-06-01", 10, 9, 50, 90, 95);

    const nowSec = tsUtc("2024-06-10T12:00:00");
    insertProbe(db, nowSec - 1800, 1, 10);
    insertProbe(db, nowSec - 600, 0, 200);

    const block = sloBlock(db, nowSec);

    expect(block).not.toBeNull();
    expect(block?.window_days).toBe(90);
    expect(block?.availability_pct).toBeCloseTo((100 * 10) / 12, 10);
    expect(block?.p50_ms).toBe(50);
    expect(block?.p99_ms).toBe(200);
    expect(block?.days).toEqual([
      { day: "2024-06-01", availability_pct: 90, p95_ms: 90 },
    ]);
    expect(block?.recent).toEqual([
      { ts: nowSec - 1800, latency_ms: 10 },
      { ts: nowSec - 600, latency_ms: 200 },
    ]);
  });

  it("weights summary percentiles by each period's sample count, not by point count", () => {
    const db = openSloDb(":memory:");
    db.prepare(
      "INSERT INTO daily (day, total, ok, p50_ms, p95_ms, p99_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("2024-03-01", 5000, 5000, 800, 950, 999);

    const nowSec = tsUtc("2024-03-10T00:00:00");
    for (let i = 0; i < 200; i++) {
      insertProbe(db, nowSec - i * 10, 1, 5);
    }

    const block = sloBlock(db, nowSec);

    // p50 pool: 800 (weight 5000) + 5 (weight 200) = 5200 points;
    // rank ceil(0.5 * 5200) = 2600 falls past the 200 low points, into 800.
    expect(block?.p50_ms).toBe(800);
    // p99 pool: 999 (weight 5000) + 5 (weight 200) = 5200 points;
    // rank ceil(0.99 * 5200) = 5148 falls past the 200 low points, into 999.
    expect(block?.p99_ms).toBe(999);
  });

  it("trims the days window to the last 90 days", () => {
    const db = openSloDb(":memory:");
    const nowSec = tsUtc("2024-06-10T00:00:00");
    const insertDaily = db.prepare(
      "INSERT INTO daily (day, total, ok, p50_ms, p95_ms, p99_ms) VALUES (?, ?, ?, ?, ?, ?)",
    );

    const insideDay = new Date((nowSec - 90 * 86400) * 1000)
      .toISOString()
      .slice(0, 10);
    const outsideDay = new Date((nowSec - 91 * 86400) * 1000)
      .toISOString()
      .slice(0, 10);
    insertDaily.run(insideDay, 1, 1, 5, 5, 5);
    insertDaily.run(outsideDay, 1, 1, 5, 5, 5);

    const block = sloBlock(db, nowSec);

    expect(block?.days.map((d) => d.day)).toEqual([insideDay]);
  });

  it("caps recent probes at 60, most-recent, oldest first", () => {
    const db = openSloDb(":memory:");
    const nowSec = tsUtc("2024-06-10T00:00:00");
    for (let i = 1; i <= 70; i++) {
      insertProbe(db, nowSec - (70 - i) * 10, 1, i);
    }

    const block = sloBlock(db, nowSec);

    expect(block?.recent).toHaveLength(60);
    expect(block?.recent[0]).toEqual({
      ts: nowSec - (70 - 11) * 10,
      latency_ms: 11,
    });
    expect(block?.recent[59]).toEqual({ ts: nowSec, latency_ms: 70 });
  });
});
