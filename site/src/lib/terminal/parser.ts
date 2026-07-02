export interface Parsed {
  cmd: string;
  args: string[];
}

/** Whitespace split with single/double-quote grouping. No escapes,
 *  pipes, globs, or vars. Never throws; an unterminated quote runs
 *  to the end of input. */
export function parse(input: string): Parsed {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);

  const [cmd = "", ...args] = tokens;
  return { cmd, args };
}
