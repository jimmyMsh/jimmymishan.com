import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_MAX_AGE_SEC = 7200;
const CONTROL_CHARS = /\p{Cc}/gu;
const URL_PATTERN = /https?:\/\/|www\./i;

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

// Constant-time compare requires equal-length inputs (it throws otherwise),
// so a length mismatch is treated as a mismatch rather than an error.
function hexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function mintToken(secret: string, nowSec: number): string {
  return `${nowSec}.${hmacHex(secret, `token:${nowSec}`)}`;
}

export function verifyToken(
  secret: string,
  token: string | undefined,
  nowSec: number,
): boolean {
  if (!token) return false;

  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;

  const tsPart = token.slice(0, dotIndex);
  const macPart = token.slice(dotIndex + 1);
  if (!/^\d+$/.test(tsPart)) return false;

  const ts = Number(tsPart);
  if (!Number.isSafeInteger(ts)) return false;

  const age = nowSec - ts;
  if (age < 0 || age > TOKEN_MAX_AGE_SEC) return false;

  return hexEquals(macPart, hmacHex(secret, `token:${ts}`));
}

export function hashIp(secret: string, ip: string): string {
  return hmacHex(secret, `ip:${ip}`);
}

export function cleanText(raw: string): string {
  return raw.replace(CONTROL_CHARS, "").trim();
}

export function containsUrl(s: string): boolean {
  return URL_PATTERN.test(s);
}

export function clientIp(header: string | undefined): string {
  return header && header.length > 0 ? header : "local";
}

export class DailyCaps {
  private readonly perIp: number;
  private readonly globalCap: number;
  private day: string | null = null;
  private perIpCounts = new Map<string, number>();
  private globalCount = 0;

  constructor(perIp: number, global: number) {
    this.perIp = perIp;
    this.globalCap = global;
  }

  allow(ipHash: string, dayUtc: string): boolean {
    if (dayUtc !== this.day) {
      this.day = dayUtc;
      this.perIpCounts.clear();
      this.globalCount = 0;
    }

    const ipCount = this.perIpCounts.get(ipHash) ?? 0;
    if (ipCount >= this.perIp || this.globalCount >= this.globalCap) {
      return false;
    }

    this.perIpCounts.set(ipHash, ipCount + 1);
    this.globalCount += 1;
    return true;
  }

  /** Give back a slot consumed by allow() when the gated action later
   * fails through no fault of the sender (e.g. upstream delivery 502). */
  refund(ipHash: string, dayUtc: string): void {
    if (dayUtc !== this.day) return;
    const ipCount = this.perIpCounts.get(ipHash) ?? 0;
    if (ipCount > 0) this.perIpCounts.set(ipHash, ipCount - 1);
    if (this.globalCount > 0) this.globalCount -= 1;
  }
}

type WriteRoute = "guestbook" | "contact";
type RejectReason =
  | "invalid"
  | "token"
  | "rate"
  | "honeypot"
  | "blocked"
  | "disabled"
  | "delivery";

export interface WriteCounterSample {
  route: string;
  kind: "accepted" | "rejected";
  reason?: string;
  count: number;
}

export class WriteCounters {
  private acceptedCounts = new Map<WriteRoute, number>();
  private rejectedCounts = new Map<string, number>();

  accepted(route: WriteRoute): void {
    this.acceptedCounts.set(route, (this.acceptedCounts.get(route) ?? 0) + 1);
  }

  rejected(route: WriteRoute, reason: RejectReason): void {
    const key = `${route}:${reason}`;
    this.rejectedCounts.set(key, (this.rejectedCounts.get(key) ?? 0) + 1);
  }

  snapshot(): WriteCounterSample[] {
    const out: WriteCounterSample[] = [];
    for (const [route, count] of this.acceptedCounts) {
      out.push({ route, kind: "accepted", count });
    }
    for (const [key, count] of this.rejectedCounts) {
      const sepIndex = key.indexOf(":");
      out.push({
        route: key.slice(0, sepIndex),
        kind: "rejected",
        reason: key.slice(sepIndex + 1),
        count,
      });
    }
    return out;
  }
}
