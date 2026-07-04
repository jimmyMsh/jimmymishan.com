import { createSocket, type Socket } from "node:dgram";
import type { SseHub } from "../sse.js";
import type { GeoLookup } from "./geo.js";

export interface LogLine {
  ts: number;
  method: string;
  path: string;
  status: number;
  country: string;
}

export interface LogEventData {
  lines: LogLine[];
  dropped: number;
}

export interface LogTailDeps {
  hub: SseHub;
  geo: GeoLookup;
  allowPrivate: boolean;
  nowSec?: () => number;
}

const RING_CAP = 100;
const EVENT_MAX_LINES = 10;
const FLUSH_INTERVAL_MS = 250;
const MAX_PATH_LEN = 80;
const SKIP_PATH = "/api/deploys/webhook";
// nginx frames each access-log datagram as RFC3164 `<PRI>timestamp host tag: msg`;
// with tag=ngx everything after this marker is the tailfmt line we care about.
const TAG_MARKER = "ngx: ";

// Strip the RFC3164 prefix (if present) and parse the tailfmt line
// `$time_iso8601 $request_method "$uri" $status $remote_addr`. The quoted field
// may hold `\xHH` escapes under escape=default, so we slice first-quote…last-quote
// rather than tokenising it. Returns the raw remote address for geo lookup; the
// caller discards it. Malformed input yields null (dropped silently upstream).
function parseLine(raw: string): {
  ts: number;
  method: string;
  path: string;
  status: number;
  ip: string;
} | null {
  const tagIndex = raw.indexOf(TAG_MARKER);
  const line = tagIndex === -1 ? raw : raw.slice(tagIndex + TAG_MARKER.length);

  const firstQuote = line.indexOf('"');
  const lastQuote = line.lastIndexOf('"');
  if (firstQuote === -1 || lastQuote === firstQuote) return null;

  const head = line.slice(0, firstQuote).trim().split(/\s+/);
  if (head.length !== 2) return null;
  const [iso, method] = head;

  const tail = line
    .slice(lastQuote + 1)
    .trim()
    .split(/\s+/);
  if (tail.length !== 2) return null;
  const [statusStr, ip] = tail;

  const status = Number(statusStr);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;

  const tsMs = Date.parse(iso);
  if (Number.isNaN(tsMs)) return null;

  return {
    ts: Math.floor(tsMs / 1000),
    method,
    path: line.slice(firstQuote + 1, lastQuote),
    status,
    ip,
  };
}

function isPrivateOrLoopback(ip: string): boolean {
  if (ip === "::1") return true;
  const lower = ip.toLowerCase();
  // fc00::/7 unique-local: first byte 0xfc or 0xfd.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  const v4 = lower.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  const octets = v4.split(".");
  if (octets.length !== 4) return false;
  const a = Number(octets[0]);
  const b = Number(octets[1]);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export class LogTail {
  private readonly hub: SseHub;
  private readonly geo: GeoLookup;
  private readonly allowPrivate: boolean;

  private readonly ring: LogLine[] = [];
  private pending: LogLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: Socket | undefined;

  constructor(deps: LogTailDeps) {
    this.hub = deps.hub;
    this.geo = deps.geo;
    this.allowPrivate = deps.allowPrivate;
  }

  ingest(rawSyslogMsg: string): void {
    const parsed = parseLine(rawSyslogMsg);
    if (parsed === null) return;

    const isPrivate = isPrivateOrLoopback(parsed.ip);
    if (isPrivate && !this.allowPrivate) return;
    if (parsed.path === SKIP_PATH) return;

    // Country lookup then discard the IP: it never reaches the LogLine.
    const country = isPrivate ? "--" : this.geo.country(parsed.ip);
    const path =
      parsed.path.length > MAX_PATH_LEN
        ? parsed.path.slice(0, MAX_PATH_LEN)
        : parsed.path;

    const line: LogLine = {
      ts: parsed.ts,
      method: parsed.method,
      path,
      status: parsed.status,
      country,
    };

    this.ring.push(line);
    if (this.ring.length > RING_CAP) this.ring.shift();

    this.pending.push(line);
    this.scheduleFlush();
  }

  recent(): LogLine[] {
    return this.ring.slice();
  }

  start(port: number): void {
    if (this.socket !== undefined) return;
    const socket = createSocket("udp4");
    socket.on("message", (msg) => {
      this.ingest(msg.toString("utf8"));
    });
    // A malformed datagram or transient socket error must not crash the
    // process, but surface it — a bind failure would otherwise disable
    // log-tail silently.
    socket.on("error", (err) => {
      console.warn(`log listener socket error: ${err.message}`);
    });
    socket.bind(port);
    socket.unref?.();
    this.socket = socket;
  }

  stop(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.socket !== undefined) {
      this.socket.close();
      this.socket = undefined;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    const timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.flushTimer = timer;
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.pending.length === 0) return;
    const lines = this.pending.slice(0, EVENT_MAX_LINES);
    const dropped = this.pending.length - lines.length;
    this.pending = [];
    this.hub.broadcast("log", { lines, dropped } satisfies LogEventData);
  }
}
