import type { ApiStatus } from "../api/types";
import type { Line } from "./types";
import { hint, text } from "./types";

export type AutoplayStep =
  | { kind: "type"; text: string }
  | { kind: "lines"; lines: Line[] }
  | { kind: "pause"; ms: number };

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) {
    return `${days} day${days === 1 ? "" : "s"}, ${hours}:${String(minutes).padStart(2, "0")}`;
  }
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}`;
  return `${minutes} min`;
}

// Bare relative magnitude ("3h", "5m") — the live line supplies its own " ago".
function relMagnitude(fromSec: number, nowSec: number): string {
  const diff = Math.max(0, Math.round(nowSec - fromSec));
  if (diff < 60) return `${diff}s`;
  const min = Math.round(diff / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

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
