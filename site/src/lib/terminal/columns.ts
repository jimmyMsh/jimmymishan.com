/** Fixed-width column: pads short values, truncates overlong ones so a
 * long name or stat can never push later columns out of alignment. */
export function padColumn(value: string, width: number): string {
  return value.length >= width
    ? `${value.slice(0, width - 1)} `
    : value.padEnd(width);
}
