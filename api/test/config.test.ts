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
      guestbookEnabled: true,
      contactDiscordWebhook: null,
      guestbookDiscordWebhook: null,
      logTailEnabled: true,
      logTailAllowPrivate: false,
      writeSecret: null,
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

  it("rejects a non-boolean GUESTBOOK_ENABLED, naming the var", () => {
    expect(() => loadConfig({ GUESTBOOK_ENABLED: "yes" })).toThrow(
      /GUESTBOOK_ENABLED/,
    );
  });

  it("parses GUESTBOOK_ENABLED=false as false", () => {
    const config = loadConfig({ GUESTBOOK_ENABLED: "false" });
    expect(config.guestbookEnabled).toBe(false);
  });

  it("parses GUESTBOOK_ENABLED=true as true", () => {
    const config = loadConfig({ GUESTBOOK_ENABLED: "true" });
    expect(config.guestbookEnabled).toBe(true);
  });

  it("carries a set CONTACT_DISCORD_WEBHOOK through", () => {
    const config = loadConfig({
      CONTACT_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/x/y",
    });
    expect(config.contactDiscordWebhook).toBe(
      "https://discord.com/api/webhooks/x/y",
    );
  });

  it("treats an empty CONTACT_DISCORD_WEBHOOK as unset", () => {
    const config = loadConfig({ CONTACT_DISCORD_WEBHOOK: "" });
    expect(config.contactDiscordWebhook).toBeNull();
  });

  it("rejects a non-boolean LOG_TAIL_ENABLED, naming the var", () => {
    expect(() => loadConfig({ LOG_TAIL_ENABLED: "nope" })).toThrow(
      /LOG_TAIL_ENABLED/,
    );
  });

  it("parses LOG_TAIL_ENABLED=false as false", () => {
    const config = loadConfig({ LOG_TAIL_ENABLED: "false" });
    expect(config.logTailEnabled).toBe(false);
  });

  it("rejects a non-boolean LOG_TAIL_ALLOW_PRIVATE, naming the var", () => {
    expect(() => loadConfig({ LOG_TAIL_ALLOW_PRIVATE: "nope" })).toThrow(
      /LOG_TAIL_ALLOW_PRIVATE/,
    );
  });

  it("parses LOG_TAIL_ALLOW_PRIVATE=true as true", () => {
    const config = loadConfig({ LOG_TAIL_ALLOW_PRIVATE: "true" });
    expect(config.logTailAllowPrivate).toBe(true);
  });

  it("treats an empty WRITE_SECRET as unset", () => {
    const config = loadConfig({ WRITE_SECRET: "" });
    expect(config.writeSecret).toBeNull();
  });

  it("carries a set WRITE_SECRET through", () => {
    const config = loadConfig({ WRITE_SECRET: "shh-write" });
    expect(config.writeSecret).toBe("shh-write");
  });

  it("defaults GUESTBOOK_DISCORD_WEBHOOK to null when unset or empty", () => {
    expect(loadConfig({}).guestbookDiscordWebhook).toBeNull();
    expect(
      loadConfig({ GUESTBOOK_DISCORD_WEBHOOK: "" }).guestbookDiscordWebhook,
    ).toBeNull();
  });

  it("passes a set GUESTBOOK_DISCORD_WEBHOOK through", () => {
    const config = loadConfig({
      GUESTBOOK_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/1/t",
    });
    expect(config.guestbookDiscordWebhook).toBe(
      "https://discord.com/api/webhooks/1/t",
    );
  });
});
