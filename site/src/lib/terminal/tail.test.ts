import { describe, expect, it, vi } from "vitest";
import type { LogEventData, LogLine, LogsResponse } from "../api/types";
import { formatLogLine, makeTailCommand } from "./tail";
import type { CommandContext, Line } from "./types";
import { createVfs } from "./vfs";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

class FakeEventSource extends EventTarget {
  closed = false;
  readyState = 0;
  close(): void {
    this.closed = true;
  }
}

function emit(source: FakeEventSource, type: string, data?: unknown): void {
  source.dispatchEvent(
    data === undefined
      ? new Event(type)
      : new MessageEvent(type, { data: JSON.stringify(data) }),
  );
}

function textOf(lines: Line[]): string {
  return lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
}

/** Flushes pending microtasks (apiFetch's fetch → race → json() chain) so
 *  assertions can run after the initial-fetch stage but before the still-open
 *  subscription settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function line(overrides: Partial<LogLine> = {}): LogLine {
  return {
    ts: 1751500000,
    method: "GET",
    path: "/projects",
    status: 200,
    country: "US",
    ...overrides,
  };
}

describe("formatLogLine", () => {
  it("golden: UTC HH:MM:SS, status, country, method, path", () => {
    expect(formatLogLine(line())).toEqual({
      segments: [{ text: "23:46:40 200 US GET /projects" }],
      kind: "output",
    });
  });
});

describe("makeTailCommand", () => {
  it("prints usage and issues no fetch with no args", async () => {
    const fetchFn = vi.fn();
    const cmd = makeTailCommand({ fetchFn });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, []);
    expect(textOf(lines)).toBe("usage: tail -f access.log");
    expect(lines[0]?.kind).toBe("error");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("prints usage and issues no fetch with the wrong filename", async () => {
    const fetchFn = vi.fn();
    const cmd = makeTailCommand({ fetchFn });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["-f", "wrong.log"]);
    expect(textOf(lines)).toBe("usage: tail -f access.log");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("happy path: prints up to 10 history lines, a hint, then appends events in order", async () => {
    const history: LogsResponse = {
      lines: Array.from({ length: 12 }, (_, i) => line({ path: `/p${i}` })),
    };
    const fetchFn = vi.fn((_path: string) =>
      Promise.resolve(jsonResponse(history)),
    );
    const source = new FakeEventSource();
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
      makeSource: () => source as unknown as EventSource,
    });
    const { ctx, lines } = makeCtx();
    cmd.run(ctx, ["-f", "access.log"]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("/api/logs");

    await flush();

    // last 10 of 12 history lines, then one hint line
    expect(lines).toHaveLength(11);
    expect(lines[0]).toEqual(formatLogLine(history.lines[2] as LogLine));
    expect(lines[9]).toEqual(formatLogLine(history.lines[11] as LogLine));
    expect(lines[10]?.kind).toBe("hint");
    expect(textOf([lines[10] as Line])).toBe(
      "tail: following access.log — ctrl+c to stop",
    );

    const eventData: LogEventData = {
      lines: [line({ path: "/a" }), line({ path: "/b" })],
      dropped: 0,
    };
    emit(source, "log", eventData);

    expect(lines).toHaveLength(13);
    expect(lines[11]).toEqual(formatLogLine(eventData.lines[0] as LogLine));
    expect(lines[12]).toEqual(formatLogLine(eventData.lines[1] as LogLine));
  });

  it("appends via writeLine, never replaceLast", async () => {
    const history: LogsResponse = { lines: [] };
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(history)));
    const source = new FakeEventSource();
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
      makeSource: () => source as unknown as EventSource,
    });
    const { ctx, lines } = makeCtx();
    let replaceCalled = false;
    ctx.writer.replaceLast = () => {
      replaceCalled = true;
    };
    cmd.run(ctx, ["-f", "access.log"]);
    await flush();

    emit(source, "log", { lines: [line()], dropped: 0 });
    expect(replaceCalled).toBe(false);
    expect(lines.at(-1)).toEqual(formatLogLine(line()));
  });

  it("emits a skipped-requests hint when dropped > 0", async () => {
    const history: LogsResponse = { lines: [] };
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(history)));
    const source = new FakeEventSource();
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
      makeSource: () => source as unknown as EventSource,
    });
    const { ctx, lines } = makeCtx();
    cmd.run(ctx, ["-f", "access.log"]);
    await flush();

    emit(source, "log", { lines: [line()], dropped: 4 });
    const hintLine = lines.at(-1);
    expect(hintLine?.kind).toBe("hint");
    expect(textOf([hintLine as Line])).toBe("… 4 requests skipped");
  });

  it("does not emit the skipped hint when dropped is 0", async () => {
    const history: LogsResponse = { lines: [] };
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(history)));
    const source = new FakeEventSource();
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
      makeSource: () => source as unknown as EventSource,
    });
    const { ctx, lines } = makeCtx();
    cmd.run(ctx, ["-f", "access.log"]);
    await flush();

    const before = lines.length;
    emit(source, "log", { lines: [line()], dropped: 0 });
    expect(lines).toHaveLength(before + 1);
  });

  it("unsubscribes and resolves on abort without writing its own ^C", async () => {
    const history: LogsResponse = { lines: [] };
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(history)));
    const source = new FakeEventSource();
    const controller = new AbortController();
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
      makeSource: () => source as unknown as EventSource,
    });
    const { ctx, lines } = makeCtx(controller.signal);
    const done = cmd.run(ctx, ["-f", "access.log"]);
    await flush();

    controller.abort();
    await done;

    expect(source.closed).toBe(true);
    expect(lines.some((l) => l.segments.some((s) => s.text === "^C"))).toBe(
      false,
    );
  });

  it("prints the disabled line on a 503 disabled at the initial fetch", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: "disabled" }, 503)),
    );
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["-f", "access.log"]);
    expect(textOf(lines)).toBe("tail: log streaming is off right now");
    expect(lines[0]?.kind).toBe("error");
  });

  it("falls back to the unreachable line on other initial fetch errors", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({}, 500)));
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx();
    await cmd.run(ctx, ["-f", "access.log"]);
    expect(textOf(lines)).toBe(
      "tail: can't reach the api — try the dashboard at /status",
    );
  });

  it("settles once with the unreachable line when onDown fires after start, no double resolve", async () => {
    const history: LogsResponse = { lines: [] };
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(history)));
    const source = new FakeEventSource();
    source.readyState = 2; // CLOSED — subscribeEvents treats every error as down
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
      makeSource: () => source as unknown as EventSource,
    });
    const { ctx, lines } = makeCtx();
    const done = cmd.run(ctx, ["-f", "access.log"]);
    await flush();

    emit(source, "error");
    emit(source, "error");
    await done;

    expect(
      lines.filter(
        (l) =>
          textOf([l]) ===
          "tail: can't reach the api — try the dashboard at /status",
      ),
    ).toHaveLength(1);
    expect(source.closed).toBe(true);
  });

  it("swallows ctrl+c mid initial-fetch instead of reporting it unreachable", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const cmd = makeTailCommand({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const { ctx, lines } = makeCtx(controller.signal);
    const run = cmd.run(ctx, ["-f", "access.log"]);
    controller.abort();
    await run;
    expect(lines).toHaveLength(0);
  });
});
