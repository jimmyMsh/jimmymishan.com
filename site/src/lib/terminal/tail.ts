import { ApiError, apiFetch, subscribeEvents } from "../api/client";
import type { LogEventData, LogLine, LogsResponse } from "../api/types";
import { type LiveDeps, unreachableLine } from "./live";
import type { Command, CommandContext, Line } from "./types";
import { errorLine, hint, text } from "./types";

const HISTORY_LINES = 10;
const OFF_LINE = errorLine("tail: log streaming is off right now");

export function formatLogLine(l: LogLine): Line {
  const time = new Date(l.ts * 1000).toISOString().slice(11, 19);
  return text(`${time} ${l.status} ${l.country} ${l.method} ${l.path}`);
}

function isTailArgs(args: string[]): boolean {
  return args.length === 2 && args[0] === "-f" && args[1] === "access.log";
}

function subscribeTail(ctx: CommandContext, deps: LiveDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const finish = (): void => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve();
    };

    // aborted (ctrl+c) — the adapter prints ^C; nothing more to write
    const onAbort = (): void => {
      finish();
    };

    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener("abort", onAbort);

    unsubscribe = subscribeEvents(
      {
        onLog(data: LogEventData) {
          for (const line of data.lines)
            ctx.writer.writeLine(formatLogLine(line));
          if (data.dropped > 0) {
            ctx.writer.writeLine(hint(`… ${data.dropped} requests skipped`));
          }
        },
        onDown() {
          if (settled) return;
          ctx.writer.writeLine(unreachableLine("tail"));
          finish();
        },
      },
      deps.makeSource,
    );
  });
}

async function runTail(ctx: CommandContext, deps: LiveDeps): Promise<void> {
  let history: LogsResponse;
  try {
    history = await apiFetch<LogsResponse>("/api/logs", {
      signal: ctx.signal,
      fetchFn: deps.fetchFn,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      if (ctx.signal.aborted) return;
      if (err.status === 503 && err.code === "disabled") {
        ctx.writer.writeLine(OFF_LINE);
        return;
      }
      ctx.writer.writeLine(unreachableLine("tail"));
      return;
    }
    throw err;
  }

  for (const line of history.lines.slice(-HISTORY_LINES)) {
    ctx.writer.writeLine(formatLogLine(line));
  }
  ctx.writer.writeLine(hint("tail: following access.log — ctrl+c to stop"));

  await subscribeTail(ctx, deps);
}

export function makeTailCommand(deps: LiveDeps): Command {
  return {
    name: "tail",
    summary: "follow the live access log",
    run(ctx, args) {
      if (!isTailArgs(args)) {
        ctx.writer.writeLine(errorLine("usage: tail -f access.log"));
        return Promise.resolve();
      }
      return runTail(ctx, deps);
    },
  };
}
