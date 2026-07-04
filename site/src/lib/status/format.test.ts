import { describe, expect, it } from "vitest";
import { fmtMiB, hhmmss, relTime } from "./format";

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

  it("clamps future timestamps to '0s ago'", () => {
    expect(relTime(now + 100, now)).toBe("0s ago");
  });
});

describe("fmtMiB", () => {
  it("appends the MiB unit to a whole number", () => {
    expect(fmtMiB(312)).toBe("312 MiB");
    expect(fmtMiB(957)).toBe("957 MiB");
    expect(fmtMiB(0)).toBe("0 MiB");
  });

  it("rounds fractional MiB to the nearest integer", () => {
    expect(fmtMiB(312.4)).toBe("312 MiB");
    expect(fmtMiB(312.6)).toBe("313 MiB");
  });
});

describe("hhmmss", () => {
  it("renders the UTC wall-clock time as HH:MM:SS", () => {
    expect(hhmmss(1751500000)).toBe("23:46:40");
  });

  it("pads a midnight timestamp to 00:00:00", () => {
    expect(hhmmss(1751414400)).toBe("00:00:00");
  });
});
