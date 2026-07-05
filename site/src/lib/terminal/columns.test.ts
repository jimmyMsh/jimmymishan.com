import { describe, expect, it } from "vitest";
import { padColumn } from "./columns";

describe("padColumn", () => {
  it("pads short values to the column width", () => {
    expect(padColumn("nginx", 10)).toBe("nginx     ");
  });
  it("truncates overlong values, keeping a one-space gap", () => {
    expect(padColumn("goatcounter", 10)).toBe("goatcount ");
  });
  it("truncates exact-width values to preserve the gap", () => {
    expect(padColumn("abcdefghij", 10)).toBe("abcdefghi ");
  });
});
