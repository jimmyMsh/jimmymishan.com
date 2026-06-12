import { describe, expect, it } from "vitest";
import { SITE_TITLE } from "./meta";

describe("site metadata", () => {
  it("exposes the site title", () => {
    expect(SITE_TITLE).toBe("Jimmy Mishan");
  });
});
