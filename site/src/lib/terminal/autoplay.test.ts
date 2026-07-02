import { describe, expect, it } from "vitest";
import { autoplayScript, finalLines } from "./autoplay";

const TAGLINE = "production engineer @ meta — fast, boring, online.";

describe("autoplayScript", () => {
  it("types whoami, prints the tagline, then the hint", () => {
    const steps = autoplayScript(TAGLINE);
    expect(steps[0]).toEqual({ kind: "type", text: "whoami" });
    const flat = JSON.stringify(steps);
    expect(flat).toContain(TAGLINE);
    expect(flat).toContain("# click and type `help` to look around");
  });
});

describe("finalLines", () => {
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
});
