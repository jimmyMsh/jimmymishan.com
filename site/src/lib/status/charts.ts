import type { SloDay } from "../api/types";

/** Rounds to at most 2 decimals and normalizes -0 to 0 for stable path strings. */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * SVG path `d` for a sparkline: x spread evenly across `w`, y min-max
 * normalized so the series maximum sits at the top (y=0) and the minimum on
 * the baseline (y=h). A flat series (or a single point) is drawn through the
 * vertical middle — never divides by a zero range. Empty series → "".
 */
export function sparklinePath(points: number[], w: number, h: number): string {
  if (points.length === 0) return "";
  const n = points.length;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;
  const xAt = (i: number): number => (n === 1 ? 0 : (i / (n - 1)) * w);
  const yAt = (v: number): number =>
    range === 0 ? h / 2 : h - ((v - min) / range) * h;
  return points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${fmt(xAt(i))} ${fmt(yAt(v))}`)
    .join(" ");
}

export type UptimeCellClass = "ok" | "warn" | "bad" | "none";

export interface UptimeCell {
  day: string;
  cls: UptimeCellClass;
}

const UPTIME_WINDOW_DAYS = 90;

function classifyDay(day: SloDay | undefined): UptimeCellClass {
  if (day === undefined) return "none";
  if (day.availability_pct >= 99.9) return "ok";
  if (day.availability_pct >= 99.0) return "warn";
  return "bad";
}

/**
 * 90 cells for the uptime bar, oldest→newest, ending on `todayIso` (a UTC
 * "YYYY-MM-DD" date). Days without a matching SLO row render as "none" (gaps);
 * present days classify by availability (ok ≥99.9, warn ≥99.0, bad below).
 */
export function uptimeBarCells(days: SloDay[], todayIso: string): UptimeCell[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const today = new Date(`${todayIso}T00:00:00Z`);
  const cells: UptimeCell[] = [];
  for (let ago = UPTIME_WINDOW_DAYS - 1; ago >= 0; ago--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - ago);
    const day = d.toISOString().slice(0, 10);
    cells.push({ day, cls: classifyDay(byDay.get(day)) });
  }
  return cells;
}
