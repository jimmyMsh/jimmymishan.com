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

/** Memory value (already in MiB) as display text, e.g. `312 MiB`. */
export function fmtMiB(mb: number): string {
  return `${Math.round(mb)} MiB`;
}
