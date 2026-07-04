// The one home for time text (dependency-free) — shared by the terminal
// commands and the status page.

/** "12 days, 3:45" / "3:45" / "12 min" uptime-style duration text. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) {
    return `${days} day${days === 1 ? "" : "s"}, ${hours}:${String(minutes).padStart(2, "0")}`;
  }
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}`;
  return `${minutes} min`;
}

/** Bare relative magnitude ("3h", "5m") — callers supply their own " ago"/suffix. */
export function relMagnitude(fromSec: number, nowSec: number): string {
  const diff = Math.max(0, Math.round(nowSec - fromSec));
  if (diff < 60) return `${diff}s`;
  const min = Math.round(diff / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** "3h ago" family: whole-unit, truncated, across s / min / h / d. Future
 * timestamps clamp to "0s ago". */
export function relTime(fromSec: number, nowSec: number): string {
  const diff = Math.max(0, Math.floor(nowSec - fromSec));
  if (diff < 60) return `${diff}s ago`;
  const min = Math.floor(diff / 60);
  if (min < 60) return `${min}min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Absolute UTC timestamp, e.g. "2026-07-03 12:00 UTC". */
export function absTime(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
