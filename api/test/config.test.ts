import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults on empty env", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      deployWebhookSecret: null,
      githubUser: "jimmyMsh",
      sseMaxConnections: 100,
      commit: "dev",
      dataDir: "/data",
    });
  });

  it("treats an empty DEPLOY_WEBHOOK_SECRET as unset", () => {
    const config = loadConfig({ DEPLOY_WEBHOOK_SECRET: "" });
    expect(config.deployWebhookSecret).toBeNull();
  });

  it("carries a set DEPLOY_WEBHOOK_SECRET through", () => {
    const config = loadConfig({ DEPLOY_WEBHOOK_SECRET: "shh" });
    expect(config.deployWebhookSecret).toBe("shh");
  });

  it("carries a set GITHUB_USER and COMMIT through", () => {
    const config = loadConfig({ GITHUB_USER: "someone", COMMIT: "abc1234" });
    expect(config.githubUser).toBe("someone");
    expect(config.commit).toBe("abc1234");
  });

  it("rejects a non-numeric SSE_MAX_CONNECTIONS", () => {
    expect(() => loadConfig({ SSE_MAX_CONNECTIONS: "abc" })).toThrow(
      /SSE_MAX_CONNECTIONS/,
    );
  });

  it("rejects an SSE_MAX_CONNECTIONS below the minimum", () => {
    expect(() => loadConfig({ SSE_MAX_CONNECTIONS: "0" })).toThrow(
      /SSE_MAX_CONNECTIONS/,
    );
  });

  it("rejects an SSE_MAX_CONNECTIONS above the maximum", () => {
    expect(() => loadConfig({ SSE_MAX_CONNECTIONS: "20000" })).toThrow(
      /SSE_MAX_CONNECTIONS/,
    );
  });

  it("accepts an SSE_MAX_CONNECTIONS within range", () => {
    const config = loadConfig({ SSE_MAX_CONNECTIONS: "250" });
    expect(config.sseMaxConnections).toBe(250);
  });
});
