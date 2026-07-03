import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiStatus } from "../api/types";
import type { AutoplayStep } from "./autoplay";
import { autoplayScript, finalLines } from "./autoplay";
import type { Line } from "./types";

const TAGLINE = "production engineer @ meta — fast, boring, online.";

const NOW = new Date("2026-07-03T12:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const DEPLOY_AT = NOW_SEC - 3 * 3600; // three hours before NOW

const LIVE: ApiStatus = {
  host: {
    cpu_pct: 7.1,
    mem_used_mb: 312,
    mem_total_mb: 957,
    load1: 0.12,
    load5: 0.08,
    load15: 0.05,
    uptime_s: 1050300, // 12 days, 3:45
  },
  history: [],
  containers: [{ name: "nginx", up: true, cpu_pct: 0.1, mem_mb: 12 }],
  deploy: { sha: "c584a9e", tag: "c584a9e", status: "ok", at: DEPLOY_AT },
  presence: 3,
  slo: null,
  commit: "c584a9e",
  api_uptime_s: 4242,
};

const LIVE_LINE =
  "# live: up 12 days, 3:45 · 3 people here now · deployed 3h ago";

function findLiveStep(
  steps: AutoplayStep[],
): Extract<AutoplayStep, { kind: "lines" }> | undefined {
  return steps.find(
    (s): s is Extract<AutoplayStep, { kind: "lines" }> =>
      s.kind === "lines" &&
      (s.lines[0]?.segments[0]?.text.startsWith("# live:") ?? false),
  );
}

describe("autoplayScript", () => {
  it("types whoami, prints the tagline, then the hint", () => {
    const steps = autoplayScript(TAGLINE);
    expect(steps[0]).toEqual({ kind: "type", text: "whoami" });
    const flat = JSON.stringify(steps);
    expect(flat).toContain(TAGLINE);
    expect(flat).toContain("# click and type `help` to look around");
  });

  it("keeps the no-arg script byte-identical to today's output", () => {
    expect(autoplayScript(TAGLINE)).toEqual([
      { kind: "type", text: "whoami" },
      { kind: "pause", ms: 350 },
      {
        kind: "lines",
        lines: [{ segments: [{ text: TAGLINE }], kind: "output" }],
      },
      { kind: "pause", ms: 650 },
      {
        kind: "lines",
        lines: [
          {
            segments: [{ text: "# click and type `help` to look around" }],
            kind: "hint",
          },
        ],
      },
    ]);
  });

  it("is byte-identical whether live is omitted or null", () => {
    expect(autoplayScript(TAGLINE, null)).toEqual(autoplayScript(TAGLINE));
  });
});

describe("autoplayScript with live data", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("inserts exactly one live step with the formatted line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const withLive = autoplayScript(TAGLINE, LIVE);
    const withoutLive = autoplayScript(TAGLINE);
    expect(withLive.length).toBe(withoutLive.length + 1);
    const step = findLiveStep(withLive);
    expect(step).toBeDefined();
    expect(step?.lines).toHaveLength(1);
    expect(step?.lines[0]?.segments[0]?.text).toBe(LIVE_LINE);
    expect(step?.lines[0]?.kind).toBe("hint");
  });

  it("drops the deployed segment when the deploy block is null", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const steps = autoplayScript(TAGLINE, { ...LIVE, deploy: null });
    const step = findLiveStep(steps);
    expect(step?.lines[0]?.segments[0]?.text).toBe(
      "# live: up 12 days, 3:45 · 3 people here now",
    );
  });
});

describe("finalLines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reduces steps to the finished transcript", () => {
    const lines = finalLines(autoplayScript(TAGLINE));
    expect(lines[0]).toEqual({
      segments: [{ text: "whoami" }],
      kind: "echo",
    });
    expect(lines.some((l) => l.segments[0]?.text === TAGLINE)).toBe(true);
    expect(lines.at(-1)?.kind).toBe("hint");
    expect(lines.some((l) => l.kind === "pre")).toBe(false);
  });

  it("ignores pauses", () => {
    expect(finalLines([{ kind: "pause", ms: 500 }])).toEqual([]);
  });

  it("mirrors the live step into the finished transcript", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lines: Line[] = finalLines(autoplayScript(TAGLINE, LIVE));
    expect(lines.some((l) => l.segments[0]?.text === LIVE_LINE)).toBe(true);
  });
});
