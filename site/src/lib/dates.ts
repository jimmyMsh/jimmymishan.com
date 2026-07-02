const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2024-06" → "Jun 2024". Anything else passes through unchanged so
 *  [PLACEHOLDER — …] date values stay visible and grep-able. */
export function formatMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return `${month} ${match[1]}`;
}

export function formatRange(start: string, end: string | null): string {
  return `${formatMonth(start)} – ${end === null ? "Present" : formatMonth(end)}`;
}
