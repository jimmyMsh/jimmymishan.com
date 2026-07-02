import { describe, expect, it } from "vitest";
import { formatMonth, formatRange } from "./dates";

describe("formatMonth", () => {
  it("formats YYYY-MM as 'Mon YYYY'", () => {
    expect(formatMonth("2024-06")).toBe("Jun 2024");
    expect(formatMonth("2022-12")).toBe("Dec 2022");
  });

  it("passes non-matching strings through (placeholder convention)", () => {
    expect(formatMonth("[PLACEHOLDER — end date]")).toBe(
      "[PLACEHOLDER — end date]",
    );
  });

  it("passes through out-of-range months", () => {
    expect(formatMonth("2024-13")).toBe("2024-13");
    expect(formatMonth("2024-00")).toBe("2024-00");
  });
});

describe("formatRange", () => {
  it("formats a closed range", () => {
    expect(formatRange("2024-06", "2024-09")).toBe("Jun 2024 – Sep 2024");
  });

  it("renders null end as Present", () => {
    expect(formatRange("2024-06", null)).toBe("Jun 2024 – Present");
  });

  it("keeps placeholder ends visible", () => {
    expect(formatRange("2024-06", "[PLACEHOLDER — end date]")).toBe(
      "Jun 2024 – [PLACEHOLDER — end date]",
    );
  });
});
