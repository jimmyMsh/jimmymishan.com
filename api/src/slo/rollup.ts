import type { DatabaseSync } from "node:sqlite";

const FOLD_AGE_SEC = 48 * 3600;
const RECENT_WINDOW_SEC = 3600;
const RECENT_CAP = 60;
const WINDOW_DAYS = 90;

// `type` (not `interface`) so these compare structurally against the
// SQLite row shape (Record<string, SQLOutputValue>) when cast below.
type ProbeRow = {
  ts: number;
  ok: number;
  latency_ms: number | null;
};

type DailyRow = {
  day: string;
  total: number | null;
  ok: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
};

export interface SloBlock {
  window_days: number;
  availability_pct: number;
  p50_ms: number;
  p99_ms: number;
  days: Array<{ day: string; availability_pct: number; p95_ms: number }>;
  recent: Array<{ ts: number; latency_ms: number }>;
}

function utcDay(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

// Rank r = ceil(p/100 * n) into values sorted ascending, 1-indexed per the
// nearest-rank method (pinned so daily rollups and the summary agree).
function nearestRank(sortedAsc: number[], percentile: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(
    Math.max(Math.ceil((percentile / 100) * sortedAsc.length), 1),
    sortedAsc.length,
  );
  return sortedAsc[rank - 1] as number;
}

type WeightedPoint = { value: number; weight: number };

// Expands each (value, weight) point into `weight` copies of `value` so a
// day (or the synthetic recent bucket) is ranked in proportion to its own
// sample count rather than as a single point, then reuses nearestRank.
function weightedNearestRank(
  points: WeightedPoint[],
  percentile: number,
): number {
  const pool: number[] = [];
  for (const { value, weight } of points) {
    for (let i = 0; i < weight; i++) pool.push(value);
  }
  return nearestRank(
    pool.sort((a, b) => a - b),
    percentile,
  );
}

export function rollup(db: DatabaseSync, nowSec: number): void {
  // A day is only folded once it has fully elapsed 48h ago (its last moment
  // is older than the cutoff) — this keeps folding a one-shot, whole-day
  // operation instead of needing to merge partial-day rollups incrementally.
  const cutoffDay = utcDay(nowSec - FOLD_AGE_SEC);
  const cutoffDayStartSec = Date.parse(`${cutoffDay}T00:00:00Z`) / 1000;

  const rows = db
    .prepare("SELECT ts, ok, latency_ms FROM probes WHERE ts < ?")
    .all(cutoffDayStartSec) as ProbeRow[];
  if (rows.length === 0) return;

  const byDay = new Map<string, ProbeRow[]>();
  for (const row of rows) {
    const day = utcDay(row.ts);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(row);
    else byDay.set(day, [row]);
  }

  const upsert = db.prepare(`
    INSERT INTO daily (day, total, ok, p50_ms, p95_ms, p99_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      total = excluded.total, ok = excluded.ok,
      p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms, p99_ms = excluded.p99_ms
  `);

  for (const [day, dayRows] of byDay) {
    const total = dayRows.length;
    const ok = dayRows.filter((r) => r.ok).length;
    const latencies = dayRows
      .map((r) => r.latency_ms)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);

    upsert.run(
      day,
      total,
      ok,
      latencies.length ? nearestRank(latencies, 50) : null,
      latencies.length ? nearestRank(latencies, 95) : null,
      latencies.length ? nearestRank(latencies, 99) : null,
    );
  }

  db.prepare("DELETE FROM probes WHERE ts < ?").run(cutoffDayStartSec);
}

export function sloBlock(db: DatabaseSync, nowSec: number): SloBlock | null {
  const windowStartDay = utcDay(nowSec - WINDOW_DAYS * 86400);
  const daily = db
    .prepare(
      "SELECT day, total, ok, p50_ms, p95_ms, p99_ms FROM daily WHERE day >= ? ORDER BY day ASC LIMIT ?",
    )
    .all(windowStartDay, WINDOW_DAYS) as DailyRow[];

  const raw = db
    .prepare("SELECT ts, ok, latency_ms FROM probes ORDER BY ts ASC")
    .all() as ProbeRow[];

  if (daily.length === 0 && raw.length === 0) return null;

  const dailyTotal = daily.reduce((sum, d) => sum + (d.total ?? 0), 0);
  const dailyOk = daily.reduce((sum, d) => sum + (d.ok ?? 0), 0);
  const rawOk = raw.filter((r) => r.ok).length;
  const totalCount = dailyTotal + raw.length;
  const availability_pct =
    totalCount === 0 ? 0 : (100 * (dailyOk + rawOk)) / totalCount;

  // Each folded day contributes its own stored percentile weighted by that
  // day's sample count, and the still-raw window folds into one synthetic
  // bucket weighted by its row count — so every day in the window counts
  // proportionally to its volume, not as one point regardless of size.
  const rawLatencies = raw
    .map((r) => r.latency_ms)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const p50Points: WeightedPoint[] = [
    ...daily
      .filter((d) => d.p50_ms !== null)
      .map((d) => ({ value: d.p50_ms as number, weight: d.total ?? 0 })),
    { value: nearestRank(rawLatencies, 50), weight: raw.length },
  ];
  const p99Points: WeightedPoint[] = [
    ...daily
      .filter((d) => d.p99_ms !== null)
      .map((d) => ({ value: d.p99_ms as number, weight: d.total ?? 0 })),
    { value: nearestRank(rawLatencies, 99), weight: raw.length },
  ];

  const recentCutoff = nowSec - RECENT_WINDOW_SEC;
  const recent = db
    .prepare(
      "SELECT ts, latency_ms FROM probes WHERE ts >= ? ORDER BY ts DESC LIMIT ?",
    )
    .all(recentCutoff, RECENT_CAP) as Array<{
    ts: number;
    latency_ms: number | null;
  }>;

  return {
    window_days: WINDOW_DAYS,
    availability_pct,
    p50_ms: weightedNearestRank(p50Points, 50),
    p99_ms: weightedNearestRank(p99Points, 99),
    days: daily.map((d) => ({
      day: d.day,
      availability_pct: d.total ? (100 * (d.ok ?? 0)) / d.total : 0,
      p95_ms: d.p95_ms ?? 0,
    })),
    recent: recent
      .map((r) => ({ ts: r.ts, latency_ms: r.latency_ms ?? 0 }))
      .reverse(),
  };
}
