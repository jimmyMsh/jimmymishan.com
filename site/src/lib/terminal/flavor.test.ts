import { describe, expect, it } from "vitest";
import { cowsayLines, flavorCommands, slFrame, TEASERS } from "./flavor";
import { CommandRegistry, execute } from "./registry";
import type { CommandContext, Line } from "./types";
import { createVfs } from "./vfs";

function makeCtx(reducedMotion = true): { ctx: CommandContext; lines: Line[] } {
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
    reducedMotion,
    signal: new AbortController().signal,
    now: () => new Date(0),
  };
  return { ctx, lines };
}

function textOf(lines: Line[]): string {
  return lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
}

function makeRegistry(): CommandRegistry {
  const reg = new CommandRegistry(TEASERS);
  for (const cmd of flavorCommands()) reg.register(cmd);
  return reg;
}

describe("teasers", () => {
  it("reserves all session-4/5 command names", () => {
    expect(Object.keys(TEASERS).sort()).toEqual([
      "deploys",
      "docker",
      "free",
      "msg",
      "sign",
      "status",
      "tail",
      "top",
      "uptime",
    ]);
  });

  it("every teaser is one dry line mentioning an upcoming deploy", () => {
    for (const line of Object.values(TEASERS)) {
      expect(line).toContain("not wired up yet");
    }
  });
});

describe("flavor commands", () => {
  it("are all hidden", () => {
    for (const cmd of flavorCommands()) expect(cmd.hidden).toBe(true);
  });

  it("sudo refuses with the classic two lines", async () => {
    const { ctx, lines } = makeCtx();
    await execute(makeRegistry(), "sudo make me a sandwich", ctx);
    expect(textOf(lines)).toBe(
      "jimmy is not in the sudoers file.\nthis incident will be reported.",
    );
  });

  it("rm refuses, deadpan", async () => {
    const { ctx, lines } = makeCtx();
    await execute(makeRegistry(), "rm -rf /", ctx);
    expect(textOf(lines)).toBe(
      "rm: refusing to remove anything — this is a production system.",
    );
  });

  it("cowsay wraps the message in the bubble", () => {
    const out = cowsayLines("moo");
    expect(out[1]).toBe("< moo >");
    expect(out.join("\n")).toContain("(oo)");
    expect(cowsayLines("")[1]).toBe("< moo >");
  });

  it("slFrame shifts right for positive offsets, slices for negative", () => {
    const at0 = slFrame(0);
    expect(slFrame(3)[0]).toBe(`   ${at0[0]}`);
    expect(slFrame(-4)[0]).toBe(at0[0]?.slice(4));
  });

  it("sl with reduced motion prints one static frame", async () => {
    const { ctx, lines } = makeCtx(true);
    await execute(makeRegistry(), "sl", ctx);
    expect(lines.length).toBe(slFrame(0).length);
    expect(lines.every((l) => l.kind === "pre")).toBe(true);
  });
});
