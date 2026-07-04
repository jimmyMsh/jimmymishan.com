import { describe, expect, it } from "vitest";
import { absTime, formatDuration, relMagnitude, relTime } from "./time";

describe("formatDuration", () => {
  it("renders minutes only when under an hour", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(2700)).toBe("45 min"); // 45 min
  });

  it("renders H:MM once an hour has passed, with no day count", () => {
    expect(formatDuration(7500)).toBe("2:05"); // 2h 5m
  });

  it("renders 'N days, H:MM' once a day has passed", () => {
    expect(formatDuration(1050300)).toBe("12 days, 3:45"); // 12d 3h 45m
  });

  it("singularizes 'day' at exactly one day", () => {
    expect(formatDuration(86400)).toBe("1 day, 0:00");
  });

  it("floors and clamps negative input to zero", () => {
    expect(formatDuration(-5)).toBe("0 min");
    expect(formatDuration(89.9)).toBe("1 min");
  });
});

describe("relMagnitude", () => {
  it("returns the bare unit with no ' ago' suffix", () => {
    expect(relMagnitude(1_000_000, 1_000_000)).toBe("0s");
    expect(relMagnitude(1_000_000 - 45, 1_000_000)).toBe("45s");
  });

  it("crosses the s / m / h / d boundaries", () => {
    const now = 1_000_000;
    expect(relMagnitude(now - 59, now)).toBe("59s");
    expect(relMagnitude(now - 60, now)).toBe("1m");
    expect(relMagnitude(now - 90, now)).toBe("2m");
    expect(relMagnitude(now - 3000, now)).toBe("50m");
    expect(relMagnitude(now - 3600, now)).toBe("1h");
    expect(relMagnitude(now - 7200, now)).toBe("2h");
    expect(relMagnitude(now - 86400, now)).toBe("1d");
    expect(relMagnitude(now - 200000, now)).toBe("2d");
  });

  it("clamps future timestamps to '0s'", () => {
    expect(relMagnitude(1_000_100, 1_000_000)).toBe("0s");
  });
});

describe("relTime", () => {
  const now = 1_000_000;

  it("crosses the s / min / h / d unit boundaries (golden table)", () => {
    expect(relTime(now, now)).toBe("0s ago");
    expect(relTime(now - 59, now)).toBe("59s ago");
    expect(relTime(now - 60, now)).toBe("1min ago");
    expect(relTime(now - 119, now)).toBe("1min ago");
    expect(relTime(now - 3599, now)).toBe("59min ago");
    expect(relTime(now - 3600, now)).toBe("1h ago");
    expect(relTime(now - 86399, now)).toBe("23h ago");
    expect(relTime(now - 86400, now)).toBe("1d ago");
    expect(relTime(now - 200000, now)).toBe("2d ago");
  });

  it("floors instead of rounding (185s reads as '3min ago', not '4min')", () => {
    expect(relTime(now - 185, now)).toBe("3min ago");
  });

  it("clamps future timestamps to '0s ago'", () => {
    expect(relTime(now + 100, now)).toBe("0s ago");
  });
});

describe("absTime", () => {
  it("renders the golden 'YYYY-MM-DD HH:MM UTC' form", () => {
    expect(absTime(1751454180)).toBe("2025-07-02 11:03 UTC");
    expect(absTime(1751454180 - 86400)).toBe("2025-07-01 11:03 UTC");
  });
});
