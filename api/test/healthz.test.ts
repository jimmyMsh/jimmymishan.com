import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("GET /api/healthz", () => {
  it("returns the health contract", async () => {
    const res = await app.request("/api/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_s).toBe("number");
    expect(body.commit).toBe("dev");
  });
});
