export interface Segment {
  text: string;
  /** absolute or site-relative URL; the adapter renders it as a link */
  href?: string;
}

export type LineKind = "output" | "echo" | "hint" | "error" | "pre";

export interface Line {
  segments: Segment[];
  kind: LineKind;
}

export function text(s: string, kind: LineKind = "output"): Line {
  return { segments: [{ text: s }], kind };
}

export function hint(s: string): Line {
  return text(s, "hint");
}

export function errorLine(s: string): Line {
  return text(s, "error");
}

export function link(label: string, href: string): Segment {
  return { text: label, href };
}

export interface Writer {
  writeLine(line: Line): void;
  /** Replace the last `count` written lines (streaming/animation seam). */
  replaceLast(count: number, lines: Line[]): void;
  clear(): void;
}

export interface VfsFile {
  name: string;
  hidden?: boolean;
  lines: Line[];
  /** "binary" files: cat prints message, then navigates */
  binary?: { message: string; navigateTo: string };
}

export interface Vfs {
  list(showHidden: boolean): string[];
  get(name: string): VfsFile | undefined;
}

export interface CommandContext {
  writer: Writer;
  vfs: Vfs;
  navigate(url: string): void;
  historyList(): readonly string[];
  reducedMotion: boolean;
  signal: AbortSignal;
  now(): Date;
}

export interface Command {
  name: string;
  /** one-liner shown by help */
  summary: string;
  /** hidden: not in help, not tab-completed */
  hidden?: boolean;
  run(ctx: CommandContext, args: string[]): void | Promise<void>;
}

export interface TerminalPayload {
  tagline: string;
  email: string;
  githubUrl: string;
  linkedinUrl: string;
  files: VfsFile[];
}
