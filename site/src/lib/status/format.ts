import type { LogEventData, LogLine } from "../api/types";

export { relTime } from "../format/time";

/** Memory value (already in MiB) as display text, e.g. `312 MiB`. */
export function fmtMiB(mb: number): string {
  return `${Math.round(mb)} MiB`;
}

/** Wall-clock time-of-day, e.g. `14:03:07` (UTC) — for the live-traffic row. */
export function hhmmss(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 19);
}

/**
 * Merges a log-stream batch into the live-traffic panel's list. `incoming`
 * arrives in wire order (oldest to newest); this reverses it before
 * prepending so the panel — which always reads newest-first — stays
 * correctly ordered even when a single event carries more than one line.
 * Capped at `cap`; an empty batch is a no-op.
 */
export function trafficLines(
  existing: LogLine[],
  incoming: LogEventData,
  cap: number,
): LogLine[] {
  if (incoming.lines.length === 0) return existing.slice();
  return [...incoming.lines].reverse().concat(existing).slice(0, cap);
}
