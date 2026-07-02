import type { Line } from "./types";
import { hint, text } from "./types";

export type AutoplayStep =
  | { kind: "type"; text: string }
  | { kind: "lines"; lines: Line[] }
  | { kind: "pause"; ms: number };

export function autoplayScript(tagline: string): AutoplayStep[] {
  return [
    { kind: "type", text: "whoami" },
    { kind: "pause", ms: 350 },
    { kind: "lines", lines: [text(tagline)] },
    { kind: "pause", ms: 650 },
    {
      kind: "lines",
      lines: [hint("# click and type `help` to look around")],
    },
  ];
}

export function finalLines(steps: AutoplayStep[]): Line[] {
  const lines: Line[] = [];
  for (const step of steps) {
    if (step.kind === "type") lines.push(text(step.text, "echo"));
    else if (step.kind === "lines") lines.push(...step.lines);
  }
  return lines;
}
