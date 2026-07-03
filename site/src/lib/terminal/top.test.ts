import { describe, expect, it } from "vitest";
import type { MetricsEventData } from "../api/types";
import { formatTopFrame, makeTopCommand, TOP_FRAME_HEIGHT } from "./top";
import type { CommandContext, Line } from "./types";
import { errorLine } from "./types";
import { createVfs } from "./vfs";

class FakeEventSource extends EventTarget {
  closed = false;
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

interface ReplaceCall {
  count: number;
  lines: Line[];
}

function makeCtx(signal: AbortSignal): {
  ctx: CommandContext;
  lines: Line[];
  replaceCalls: ReplaceCall[];
  announced: Line[];
} {
  const lines: Line[] = [];
  const replaceCalls: ReplaceCall[] = [];
  const announced: Line[] = [];
  const ctx: CommandContext = {
    writer: {
      writeLine: (l) => {
        announced.push(l);
        lines.push(l);
      },
      replaceLast: (count, next) => {
        replaceCalls.push({ count, lines: next });
        lines.splice(-count, count, ...next);
      },
      clear: () => lines.splice(0),
    },
    vfs: createVfs([]),
    navigate: () => {},
    historyList: () => [],
    reducedMotion: true,
    signal,
    now: () => new Date(0),
  };
  return { ctx, lines, replaceCalls, announced };
}

const UNREACHABLE = errorLine(
  "top: can't reach the api — try the dashboard at /status",
);

const FIXTURE_METRICS: MetricsEventData = {
  ts: 1,
  host: { cpu_pct: 4.2, mem_used_mb: 300, mem_total_mb: 957, load1: 0.15 },
  containers: [
    { name: "nginx", up: true, cpu_pct: 0.2, mem_mb: 10 },
    { name: "api", up: false, cpu_pct: null, mem_mb: null },
  ],
  probe_ms: 38,
};

describe("formatTopFrame", () => {
  it("renders a host line, a table header, and padded container rows", () => {
    const lines = formatTopFrame(FIXTURE_METRICS);
    expect(lines).toHaveLength(TOP_FRAME_HEIGHT);
    expect(textOf(lines)).toBe(
      "cpu 4.2% · mem 300/957 MiB · load 0.15 · probe 38ms\n" +
        "NAME      STATUS   CPU     MEM\n" +
        "nginx     up       0.2%    10 MiB\n" +
        "api       down     -       -\n" +
        "\n",
    );
  });

  it("shows a dash for a null probe", () => {
    const lines = formatTopFrame({ ...FIXTURE_METRICS, probe_ms: null });
    expect(textOf(lines)).toContain("probe -");
  });
});

function run(makeSource: (url: string) => EventSource) {
  const controller = new AbortController();
  const { ctx, lines, replaceCalls, announced } = makeCtx(controller.signal);
  const cmd = makeTopCommand({ makeSource, unreachableLine: UNREACHABLE });
  const done = Promise.resolve(cmd.run(ctx, []));
  return { controller, ctx, lines, replaceCalls, announced, done };
}

describe("makeTopCommand", () => {
  it("writes an initial waiting frame before subscribing", () => {
    const source = new FakeEventSource();
    const { lines } = run(() => source as unknown as EventSource);
    expect(lines).toHaveLength(TOP_FRAME_HEIGHT);
    expect(textOf(lines)).toContain("waiting for data");
  });

  it("replaces the frame with a constant line count on each metrics event", () => {
    const source = new FakeEventSource();
    const { lines, replaceCalls } = run(() => source as unknown as EventSource);

    emit(source, "metrics", FIXTURE_METRICS);
    emit(source, "metrics", {
      ...FIXTURE_METRICS,
      host: { ...FIXTURE_METRICS.host, cpu_pct: 9.9 },
    });

    expect(replaceCalls).toHaveLength(2);
    expect(replaceCalls[0]?.count).toBe(TOP_FRAME_HEIGHT);
    expect(replaceCalls[1]?.count).toBe(TOP_FRAME_HEIGHT);
    expect(lines).toHaveLength(TOP_FRAME_HEIGHT);
    expect(textOf(lines)).toContain("cpu 9.9%");
  });

  it("unsubscribes and resolves on abort without writing its own ^C", async () => {
    const source = new FakeEventSource();
    const { controller, lines, done } = run(
      () => source as unknown as EventSource,
    );

    emit(source, "metrics", FIXTURE_METRICS);
    controller.abort();
    await done;

    expect(source.closed).toBe(true);
    expect(lines.some((l) => l.segments.some((s) => s.text === "^C"))).toBe(
      false,
    );
  });

  it("announces a single error line via writeLine and leaks no subscription when the stream goes down", async () => {
    const source = new FakeEventSource();
    const { lines, announced, replaceCalls, done } = run(
      () => source as unknown as EventSource,
    );

    emit(source, "error");
    emit(source, "error");
    emit(source, "error");
    await done;

    expect(source.closed).toBe(true);
    expect(lines).toEqual([UNREACHABLE]);
    // the error reaches the role=log region (announced), never the aria-hidden
    // replaceLast frame path
    expect(announced).toContain(UNREACHABLE);
    expect(replaceCalls.some((c) => c.lines.includes(UNREACHABLE))).toBe(false);
  });

  it("ignores down events after settling, announcing the error exactly once", async () => {
    const source = new FakeEventSource();
    // readyState CLOSED makes subscribeEvents treat every error as a down event
    (source as unknown as { readyState: number }).readyState = 2;
    const { announced, done } = run(() => source as unknown as EventSource);

    emit(source, "error");
    emit(source, "error");
    await done;

    expect(announced.filter((l) => l === UNREACHABLE)).toHaveLength(1);
  });
});
