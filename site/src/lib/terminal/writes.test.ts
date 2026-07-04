import { describe, expect, it, vi } from "vitest";
import type { CommandContext, Line } from "./types";
import { createVfs } from "./vfs";
import { makeMsgCommand, makeSignCommand } from "./writes";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Mirrors NGINX's own rate limiter, which returns an HTML 429 before the
// request reaches the app — the body isn't JSON, so `code` stays undefined
// while `status` is 429 (see parseErrorBody swallowing the parse failure).
function nonJsonResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
  } as unknown as Response;
}

function textOf(lines: Line[]): string {
  return lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
}

function makeCtx(signal = new AbortController().signal): {
  ctx: CommandContext;
  lines: Line[];
} {
  const lines: Line[] = [];
  const ctx: CommandContext = {
    writer: {
      writeLine: (l) => lines.push(l),
      replaceLast: (count, next) => lines.splice(-count, count, ...next),
      clear: () => lines.splice(0),
    },
    vfs: createVfs([]),
    navigate: () => {},
    historyList: () => [],
    reducedMotion: true,
    signal,
    now: () => new Date(0),
  };
  return { ctx, lines };
}

const TOKEN_RESPONSE = { token: "tok123" };

describe("makeSignCommand", () => {
  it("prints usage with no message and issues no fetch", async () => {
    const fetchFn = vi.fn();
    const cmd = makeSignCommand({ fetchFn });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, []);
    expect(textOf(lines)).toBe('usage: sign "message" [--by name]');
    expect(lines[0]?.kind).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("parses --by from any position", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ entry: { id: 1 } }, 201),
      );
    });
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx } = makeCtx();
    await cmd.run(ctx, ["--by", "ada", "hello there"]);

    expect(calls[0]?.path).toBe("/api/write-token");
    expect(calls[1]?.path).toBe("/api/guestbook");
    const body = JSON.parse(calls[1]?.init?.body as string);
    expect(body).toEqual({
      token: "tok123",
      name: "ada",
      message: "hello there",
    });
  });

  it("happy path: GET write-token then POST guestbook with token+fields", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ entry: { id: 1 } }, 201),
      );
    });
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hello there"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/api/write-token");
    expect(calls[1]?.path).toBe("/api/guestbook");
    expect(calls[1]?.init?.method).toBe("POST");
    const body = JSON.parse(calls[1]?.init?.body as string);
    expect(body).toEqual({
      token: "tok123",
      name: "anonymous",
      message: "hello there",
    });
    expect(textOf(lines)).toContain("signed — thanks, anonymous.");
    const hintLine = lines.at(-1);
    expect(hintLine?.kind).toBe("hint");
    expect(hintLine?.segments.some((s) => s.href === "/guestbook")).toBe(true);
  });

  it.each([
    ["rate_limited", "sign: rate limit hit — try again tomorrow"],
    ["disabled", "sign: signing is closed right now"],
  ])("maps guestbook error code %s to its pinned line", async (code, want) => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ error: code }, 400),
      ),
    );
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hello"]);
    expect(textOf(lines)).toBe(want);
    expect(lines[0]?.kind).toBe("error");
  });

  it("maps invalid+url field to the guestbook-specific line", async () => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ error: "invalid", field: "url" }, 400),
      ),
    );
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["check http://evil.example"]);
    expect(textOf(lines)).toBe("sign: links aren't allowed in the guestbook");
  });

  it("maps other invalid fields to the generic validation line", async () => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ error: "invalid", field: "message" }, 400),
      ),
    );
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hello"]);
    expect(textOf(lines)).toBe("sign: that didn't validate — message");
  });

  it("maps invalid with no field to a field-less validation line", async () => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ error: "invalid" }, 400),
      ),
    );
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hello"]);
    expect(textOf(lines)).toBe("sign: that didn't validate");
  });

  it("falls back to the unreachable line with no error code", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({}, 500)));
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hello"]);
    expect(textOf(lines)).toBe(
      "sign: can't reach the api — try the dashboard at /status",
    );
  });

  it("maps an NGINX-layer 429 (non-JSON body, code undefined) to the rate-limit line", async () => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : nonJsonResponse(429),
      ),
    );
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hello"]);
    expect(textOf(lines)).toBe("sign: rate limit hit — try again tomorrow");
  });

  it("swallows ctrl+c mid-flight instead of reporting it unreachable", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const cmd = makeSignCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx(controller.signal);
    const run = cmd.run(ctx, ["hello"]);
    controller.abort();
    await run;
    expect(lines).toHaveLength(0);
  });
});

describe("makeMsgCommand", () => {
  it("prints usage with no message and issues no fetch", async () => {
    const fetchFn = vi.fn();
    const cmd = makeMsgCommand({ fetchFn });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, []);
    expect(textOf(lines)).toBe('usage: msg "text" [--from you@example.com]');
    expect(lines[0]?.kind).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("parses --from from any position", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ sent: true }),
      );
    });
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx } = makeCtx();
    await cmd.run(ctx, ["--from", "ada@example.com", "hi there"]);

    const body = JSON.parse(calls[1]?.init?.body as string);
    expect(body).toEqual({
      token: "tok123",
      message: "hi there",
      from: "ada@example.com",
    });
  });

  it("happy path: GET write-token then POST contact, no from when omitted", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ sent: true }),
      );
    });
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hi there"]);

    expect(calls[0]?.path).toBe("/api/write-token");
    expect(calls[1]?.path).toBe("/api/contact");
    expect(calls[1]?.init?.method).toBe("POST");
    const body = JSON.parse(calls[1]?.init?.body as string);
    expect(body).toEqual({ token: "tok123", message: "hi there" });
    expect(textOf(lines)).toBe("sent. i read these — thanks.");
  });

  it.each([
    ["rate_limited", "msg: rate limit hit — try again tomorrow"],
    ["disabled", "msg: messages are closed right now"],
    [
      "delivery_failed",
      "msg: couldn't deliver — email jimmymishan2004@gmail.com instead",
    ],
  ])("maps contact error code %s to its pinned line", async (code, want) => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ error: code }, 400),
      ),
    );
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hi"]);
    expect(textOf(lines)).toBe(want);
  });

  it("maps other invalid fields to the generic validation line", async () => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : jsonResponse({ error: "invalid", field: "from" }, 400),
      ),
    );
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hi", "--from", "not-an-email"]);
    expect(textOf(lines)).toBe("msg: that didn't validate — from");
  });

  it("falls back to the unreachable line with no error code", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({}, 500)));
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hi"]);
    expect(textOf(lines)).toBe(
      "msg: can't reach the api — try the dashboard at /status",
    );
  });

  it("maps an NGINX-layer 429 (non-JSON body, code undefined) to the rate-limit line", async () => {
    const fetchFn = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/write-token"
          ? jsonResponse(TOKEN_RESPONSE)
          : nonJsonResponse(429),
      ),
    );
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["hi"]);
    expect(textOf(lines)).toBe("msg: rate limit hit — try again tomorrow");
  });

  it("swallows ctrl+c mid-flight instead of reporting it unreachable", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const cmd = makeMsgCommand({ fetchFn: fetchFn as unknown as typeof fetch });
    const { ctx, lines } = makeCtx(controller.signal);
    const run = cmd.run(ctx, ["hi"]);
    controller.abort();
    await run;
    expect(lines).toHaveLength(0);
  });
});
