import { describe, expect, it } from "vitest";
import { CommandRegistry, execute } from "./registry";
import type { CommandContext, Line } from "./types";
import { text } from "./types";
import { createVfs } from "./vfs";

function makeCtx(): { ctx: CommandContext; lines: Line[] } {
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
    signal: new AbortController().signal,
    now: () => new Date(0),
  };
  return { ctx, lines };
}

function textOf(lines: Line[]): string {
  return lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
}

describe("CommandRegistry", () => {
  it("lists only visible commands, in registration order", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "b", summary: "", run: () => {} });
    reg.register({ name: "a", summary: "", hidden: true, run: () => {} });
    expect(reg.listed().map((c) => c.name)).toEqual(["b"]);
  });

  it("completes only visible command names, sorted", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "help", summary: "", run: () => {} });
    reg.register({ name: "history", summary: "", run: () => {} });
    reg.register({ name: "sudo", summary: "", hidden: true, run: () => {} });
    expect(reg.completions("h")).toEqual(["help", "history"]);
    expect(reg.completions("s")).toEqual([]);
  });

  it("register replaces a same-named teaser (session-4 seam)", () => {
    const reg = new CommandRegistry({ uptime: "uptime: soon." });
    expect(reg.teaser("uptime")).toBe("uptime: soon.");
    reg.register({ name: "uptime", summary: "", run: () => {} });
    expect(reg.teaser("uptime")).toBeUndefined();
  });
});

describe("execute", () => {
  it("does nothing on blank input", async () => {
    const { ctx, lines } = makeCtx();
    await execute(new CommandRegistry(), "   ", ctx);
    expect(lines).toEqual([]);
  });

  it("runs a registered command with parsed args", async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "echoish",
      summary: "",
      run: (c, args) => c.writer.writeLine(text(args.join("|"))),
    });
    const { ctx, lines } = makeCtx();
    await execute(reg, 'echoish "a b" c', ctx);
    expect(textOf(lines)).toBe("a b|c");
  });

  it("prints the teaser for reserved future commands", async () => {
    const reg = new CommandRegistry({ uptime: "uptime: soon." });
    const { ctx, lines } = makeCtx();
    await execute(reg, "uptime", ctx);
    expect(textOf(lines)).toBe("uptime: soon.");
  });

  it("prints command-not-found otherwise", async () => {
    const { ctx, lines } = makeCtx();
    await execute(new CommandRegistry(), "wat", ctx);
    expect(textOf(lines)).toBe("command not found: wat — try `help`");
  });

  it("catches a throwing handler and keeps the prompt alive", async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "boom",
      summary: "",
      run: () => {
        throw new Error("kaboom");
      },
    });
    const { ctx, lines } = makeCtx();
    await execute(reg, "boom", ctx);
    expect(textOf(lines)).toBe("boom: something went wrong");
  });
});
