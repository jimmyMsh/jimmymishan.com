import { describe, expect, it } from "vitest";
import { tokenRoute } from "../src/routes/token.js";
import {
  cleanText,
  containsUrl,
  DailyCaps,
  hashIp,
  mintToken,
  verifyToken,
  WriteCounters,
} from "../src/writes/gate.js";

const SECRET = "gate-secret";
const FIXED_NOW = 1_700_000_000;

describe("mintToken / verifyToken", () => {
  it("round-trips a freshly minted token at a fixed clock", () => {
    const token = mintToken(SECRET, FIXED_NOW);
    expect(verifyToken(SECRET, token, FIXED_NOW)).toBe(true);
  });

  it("accepts a token exactly at the 7200s expiry boundary", () => {
    const token = mintToken(SECRET, FIXED_NOW);
    expect(verifyToken(SECRET, token, FIXED_NOW + 7200)).toBe(true);
  });

  it("rejects a token one second past the 7200s expiry boundary", () => {
    const token = mintToken(SECRET, FIXED_NOW);
    expect(verifyToken(SECRET, token, FIXED_NOW + 7201)).toBe(false);
  });

  it("rejects a token with a tampered hex signature", () => {
    const token = mintToken(SECRET, FIXED_NOW);
    const [ts, mac] = token.split(".");
    const tampered = `${ts}.${mac?.slice(0, -1)}${mac?.at(-1) === "0" ? "1" : "0"}`;
    expect(verifyToken(SECRET, tampered, FIXED_NOW)).toBe(false);
  });

  it("rejects a token with no dot separator", () => {
    expect(verifyToken(SECRET, "not-a-token", FIXED_NOW)).toBe(false);
  });

  it("rejects a token with a non-numeric timestamp segment", () => {
    expect(verifyToken(SECRET, "abc.deadbeef", FIXED_NOW)).toBe(false);
  });

  it("rejects a token whose timestamp is in the future", () => {
    const token = mintToken(SECRET, FIXED_NOW + 1000);
    expect(verifyToken(SECRET, token, FIXED_NOW)).toBe(false);
  });

  it("rejects an undefined token", () => {
    expect(verifyToken(SECRET, undefined, FIXED_NOW)).toBe(false);
  });

  it("rejects a token minted with a different secret", () => {
    const token = mintToken("other-secret", FIXED_NOW);
    expect(verifyToken(SECRET, token, FIXED_NOW)).toBe(false);
  });
});

describe("hashIp", () => {
  it("produces a different value than mintToken for the same shared input (purpose separation)", () => {
    const shared = "12345";
    const tokenHalf = mintToken(SECRET, Number(shared)).split(".")[1];
    expect(hashIp(SECRET, shared)).not.toBe(tokenHalf);
  });

  it("is deterministic for the same secret and ip", () => {
    expect(hashIp(SECRET, "203.0.113.5")).toBe(hashIp(SECRET, "203.0.113.5"));
  });

  it("differs for different ips", () => {
    expect(hashIp(SECRET, "203.0.113.5")).not.toBe(
      hashIp(SECRET, "203.0.113.6"),
    );
  });
});

describe("cleanText", () => {
  it("strips C0 control characters and trims", () => {
    expect(cleanText("  hi\x00there\x1f  ")).toBe("hithere");
  });

  it("strips C1 control characters (0x7f-0x9f)", () => {
    expect(cleanText("a\x7fb\x9fc")).toBe("abc");
  });

  it("leaves ordinary text untouched apart from trimming", () => {
    expect(cleanText("  hello world  ")).toBe("hello world");
  });
});

describe("containsUrl", () => {
  it("matches an uppercase HTTP scheme", () => {
    expect(containsUrl("visit HTTP://example.com now")).toBe(true);
  });

  it("matches a bare www. prefix", () => {
    expect(containsUrl("go to www.example.com")).toBe(true);
  });

  it("matches https://", () => {
    expect(containsUrl("https://example.com")).toBe(true);
  });

  it("does not match a bare domain with no scheme or www", () => {
    expect(containsUrl("example.com")).toBe(false);
  });
});

describe("DailyCaps", () => {
  it("allows up to perIp requests for a single ip and denies the next", () => {
    const caps = new DailyCaps(2, 100);
    expect(caps.allow("ip-a", "2026-07-03")).toBe(true);
    expect(caps.allow("ip-a", "2026-07-03")).toBe(true);
    expect(caps.allow("ip-a", "2026-07-03")).toBe(false);
  });

  it("tracks a second ip independently of the first", () => {
    const caps = new DailyCaps(2, 100);
    caps.allow("ip-a", "2026-07-03");
    caps.allow("ip-a", "2026-07-03");
    expect(caps.allow("ip-a", "2026-07-03")).toBe(false);
    expect(caps.allow("ip-b", "2026-07-03")).toBe(true);
  });

  it("denies once the global cap is hit even across distinct ips", () => {
    const caps = new DailyCaps(100, 2);
    expect(caps.allow("ip-a", "2026-07-03")).toBe(true);
    expect(caps.allow("ip-b", "2026-07-03")).toBe(true);
    expect(caps.allow("ip-c", "2026-07-03")).toBe(false);
  });

  it("resets counts once the day key advances", () => {
    const caps = new DailyCaps(1, 100);
    expect(caps.allow("ip-a", "2026-07-03")).toBe(true);
    expect(caps.allow("ip-a", "2026-07-03")).toBe(false);
    expect(caps.allow("ip-a", "2026-07-04")).toBe(true);
  });

  it("refund restores a consumed slot within the same day", () => {
    const caps = new DailyCaps(1, 10);
    expect(caps.allow("ip1", "2026-07-05")).toBe(true);
    expect(caps.allow("ip1", "2026-07-05")).toBe(false);
    caps.refund("ip1", "2026-07-05");
    expect(caps.allow("ip1", "2026-07-05")).toBe(true);
  });

  it("refund is a no-op across a day boundary", () => {
    const caps = new DailyCaps(1, 10);
    expect(caps.allow("ip1", "2026-07-05")).toBe(true);
    caps.refund("ip1", "2026-07-06");
    expect(caps.allow("ip1", "2026-07-05")).toBe(false);
  });
});

describe("WriteCounters", () => {
  it("snapshots accepted counts by route", () => {
    const counters = new WriteCounters();
    counters.accepted("guestbook");
    counters.accepted("guestbook");
    counters.accepted("contact");

    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        { route: "guestbook", kind: "accepted", count: 2 },
        { route: "contact", kind: "accepted", count: 1 },
      ]),
    );
  });

  it("snapshots rejected counts by route and reason", () => {
    const counters = new WriteCounters();
    counters.rejected("guestbook", "honeypot");
    counters.rejected("guestbook", "honeypot");
    counters.rejected("contact", "rate");

    expect(counters.snapshot()).toEqual(
      expect.arrayContaining([
        {
          route: "guestbook",
          kind: "rejected",
          reason: "honeypot",
          count: 2,
        },
        { route: "contact", kind: "rejected", reason: "rate", count: 1 },
      ]),
    );
  });

  it("returns an empty snapshot when nothing has happened", () => {
    const counters = new WriteCounters();
    expect(counters.snapshot()).toEqual([]);
  });
});

describe("GET /api/write-token", () => {
  it("returns a token that verifies against the same secret and clock", async () => {
    const app = tokenRoute({ secret: SECRET, nowSec: () => FIXED_NOW });

    const res = await app.request("/api/write-token");
    const body = (await res.json()) as { token: string };

    expect(res.status).toBe(200);
    expect(verifyToken(SECRET, body.token, FIXED_NOW)).toBe(true);
  });
});
