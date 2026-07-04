import { describe, expect, it } from "vitest";
import type { LogLine } from "../api/types";
import { trafficLines } from "./format";

function line(ts: number): LogLine {
  return { ts, method: "GET", path: "/x", status: 200, country: "US" };
}

describe("trafficLines", () => {
  it("prepends an incoming batch newest-first ahead of the existing list", () => {
    // existing is already newest-first; incoming arrives oldest..newest
    // (the wire order from the log pipeline) and must be flipped so 500
    // — the newest line overall — lands at the very front.
    const existing = [line(300), line(200)];
    const incoming = { lines: [line(400), line(500)], dropped: 0 };

    const result = trafficLines(existing, incoming, 15);

    expect(result.map((l) => l.ts)).toEqual([500, 400, 300, 200]);
  });

  it("caps the merged list at `cap`, keeping the newest entries", () => {
    const existing = [line(100), line(90), line(80)];
    const incoming = { lines: [line(110), line(120)], dropped: 0 };

    const result = trafficLines(existing, incoming, 4);

    expect(result.map((l) => l.ts)).toEqual([120, 110, 100, 90]);
  });

  it("is a no-op on an empty incoming batch", () => {
    const existing = [line(100), line(90)];

    const result = trafficLines(existing, { lines: [], dropped: 3 }, 15);

    expect(result).toEqual(existing);
    expect(result).not.toBe(existing);
  });
});
