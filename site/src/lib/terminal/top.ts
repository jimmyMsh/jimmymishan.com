import { subscribeEvents } from "../api/client";
import type { MetricsEventData } from "../api/types";
import type { Command, CommandContext, Line } from "./types";
import { hint, text } from "./types";

// Curated container list is small and fixed at deploy time (nginx, api);
// this cap just keeps the frame height constant even if it grows a bit.
const MAX_CONTAINER_ROWS = 4;
export const TOP_FRAME_HEIGHT = 2 + MAX_CONTAINER_ROWS;

function padEnd(value: string, width: number): string {
  return value.padEnd(width);
}

function hostLine(data: MetricsEventData): Line {
  const probe = data.probe_ms === null ? "-" : `${data.probe_ms}ms`;
  const { host } = data;
  return text(
    `cpu ${host.cpu_pct}% · mem ${host.mem_used_mb}/${host.mem_total_mb} MiB · load ${host.load1} · probe ${probe}`,
  );
}

function tableHeader(): Line {
  return text(
    `${padEnd("NAME", 10)}${padEnd("STATUS", 9)}${padEnd("CPU", 8)}MEM`,
  );
}

function containerRow(c: MetricsEventData["containers"][number]): Line {
  const cpu = c.cpu_pct === null ? "-" : `${c.cpu_pct}%`;
  const mem = c.mem_mb === null ? "-" : `${c.mem_mb} MiB`;
  return text(
    `${padEnd(c.name, 10)}${padEnd(c.up ? "up" : "down", 9)}${padEnd(cpu, 8)}${mem}`,
  );
}

export function formatTopFrame(data: MetricsEventData): Line[] {
  const rows = data.containers.slice(0, MAX_CONTAINER_ROWS).map(containerRow);
  while (rows.length < MAX_CONTAINER_ROWS) rows.push(text(""));
  return [hostLine(data), tableHeader(), ...rows];
}

function placeholderFrame(): Line[] {
  const lines: Line[] = [
    text("top — live host + container stats"),
    hint("waiting for data…"),
  ];
  while (lines.length < TOP_FRAME_HEIGHT) lines.push(text(""));
  return lines;
}

export interface TopDeps {
  makeSource?: (url: string) => EventSource;
  /** the shared unreachable-api error line, built by the caller so the wording matches the other live commands */
  unreachableLine: Line;
}

function runTop(ctx: CommandContext, deps: TopDeps): Promise<void> {
  const initial = placeholderFrame();
  for (const line of initial) ctx.writer.writeLine(line);
  let lastFrame = initial;

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

    // aborted (ctrl+c) — the adapter prints ^C; leave the last frame
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
        onMetrics(data) {
          lastFrame = formatTopFrame(data);
          ctx.writer.replaceLast(TOP_FRAME_HEIGHT, lastFrame);
        },
        onDown() {
          if (settled) return;
          // Collapse the aria-hidden frame region, then deliver the error via
          // writeLine so it lands in the announced role="log" region.
          ctx.writer.replaceLast(TOP_FRAME_HEIGHT, []);
          ctx.writer.writeLine(deps.unreachableLine);
          finish();
        },
      },
      deps.makeSource,
    );
  });
}

export function makeTopCommand(deps: TopDeps): Command {
  return {
    name: "top",
    summary: "live host and container stats",
    run(ctx) {
      return runTop(ctx, deps);
    },
  };
}
