import type { ApiStatus } from "../api/types";
import { formatDuration, relMagnitude } from "../format/time";
import type { Line } from "./types";
import { hint, text } from "./types";

export type AutoplayStep =
  | { kind: "type"; text: string }
  | { kind: "lines"; lines: Line[] }
  | { kind: "pause"; ms: number };

function liveStepLine(live: ApiStatus): Line {
  const parts = [
    `up ${formatDuration(live.host.uptime_s)}`,
    `${live.presence} people here now`,
  ];
  if (live.deploy !== null) {
    const nowSec = Math.floor(Date.now() / 1000);
    parts.push(`deployed ${relMagnitude(live.deploy.at, nowSec)} ago`);
  }
  return hint(`# live: ${parts.join(" · ")}`);
}

export function autoplayScript(
  tagline: string,
  live?: ApiStatus | null,
): AutoplayStep[] {
  const steps: AutoplayStep[] = [
    { kind: "type", text: "whoami" },
    { kind: "pause", ms: 350 },
    { kind: "lines", lines: [text(tagline)] },
    { kind: "pause", ms: 650 },
  ];
  if (live) steps.push({ kind: "lines", lines: [liveStepLine(live)] });
  steps.push({
    kind: "lines",
    lines: [hint("# click and type `help` to look around")],
  });
  return steps;
}

export function finalLines(steps: AutoplayStep[]): Line[] {
  const lines: Line[] = [];
  for (const step of steps) {
    if (step.kind === "type") lines.push(text(step.text, "echo"));
    else if (step.kind === "lines") lines.push(...step.lines);
  }
  return lines;
}
