import { describe, expect, it } from "vitest";
import type { SloDay } from "../api/types";
import { sparklinePath, uptimeBarCells } from "./charts";

describe("sparklinePath", () => {
  it("maps a 3-point series to a min-max normalized path (golden)", () => {
    // min (0) sits on the baseline (y=h), max (10) at the top (y=0),
    // x is spread evenly across the width
    expect(sparklinePath([0, 5, 10], 100, 20)).toBe("M 0 20 L 50 10 L 100 0");
  });

  it("draws a flat series through the vertical middle, never dividing by zero", () => {
    expect(sparklinePath([3, 3, 3], 100, 20)).toBe("M 0 10 L 50 10 L 100 10");
  });

  it("returns an empty string for an empty series", () => {
    expect(sparklinePath([], 100, 20)).toBe("");
  });

  it("places a single point at the left edge, vertically centered", () => {
    expect(sparklinePath([7], 100, 20)).toBe("M 0 10");
  });
});

describe("uptimeBarCells", () => {
  const today = "2026-07-03";

  it("classifies availability exactly at the 99.9 / 99.0 thresholds", () => {
    const days: SloDay[] = [
      { day: "2026-07-03", availability_pct: 99.9, p95_ms: 50 },
      { day: "2026-07-02", availability_pct: 99.0, p95_ms: 50 },
      { day: "2026-07-01", availability_pct: 98.9, p95_ms: 50 },
    ];
    const cells = uptimeBarCells(days, today);
    expect(cells.at(-1)).toEqual({ day: "2026-07-03", cls: "ok" });
    expect(cells.at(-2)).toEqual({ day: "2026-07-02", cls: "warn" });
    expect(cells.at(-3)).toEqual({ day: "2026-07-01", cls: "bad" });
  });

  it("marks days with no probe data as 'none'", () => {
    const cells = uptimeBarCells([], today);
    const gap = cells.find((c) => c.day === "2026-06-30");
    expect(gap?.cls).toBe("none");
  });

  it("returns 90 cells ordered oldest to newest, ending on today", () => {
    const cells = uptimeBarCells([], today);
    expect(cells).toHaveLength(90);
    expect(cells[0]?.day).toBe("2026-04-05");
    expect(cells.at(-1)?.day).toBe("2026-07-03");
  });
});
