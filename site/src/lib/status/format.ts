export { relTime } from "../format/time";

/** Memory value (already in MiB) as display text, e.g. `312 MiB`. */
export function fmtMiB(mb: number): string {
  return `${Math.round(mb)} MiB`;
}
