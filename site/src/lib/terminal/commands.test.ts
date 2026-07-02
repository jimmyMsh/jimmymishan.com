import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommands, OPEN_TARGET_NAMES } from "./commands";
import { buildFiles } from "./content";
import { CommandRegistry, execute } from "./registry";
import type { CommandContext, Line } from "./types";
import { createVfs } from "./vfs";

const deps = {
  tagline:
    "production engineer @ meta — I keep systems fast, boring, and online.",
  email: "j@example.com",
  githubUrl: "https://github.com/jimmyMsh",
  linkedinUrl: "https://www.linkedin.com/in/jimmymishan/",
};

let registry: CommandRegistry;
let lines: Line[];
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;
let ctx: CommandContext;

function textOf(): string {
  return lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
}

beforeEach(() => {
  registry = new CommandRegistry();
  lines = [];
  navigate = vi.fn<(url: string) => void>();
  ctx = {
    writer: {
      writeLine: (l) => lines.push(l),
      replaceLast: (count, next) => lines.splice(-count, count, ...next),
      clear: () => lines.splice(0),
    },
    vfs: createVfs(buildFiles([], [], deps)),
    navigate,
    historyList: () => ["help", "ls"],
    reducedMotion: true,
    signal: new AbortController().signal,
    now: () => new Date("2026-07-02T12:00:00"),
  };
  for (const cmd of createCommands(registry, deps)) registry.register(cmd);
});

describe("built-ins", () => {
  it("help lists visible commands and the not-everything hint", async () => {
    await execute(registry, "help", ctx);
    const out = textOf();
    for (const name of [
      "help",
      "whoami",
      "ls",
      "cat",
      "open",
      "pwd",
      "echo",
      "date",
      "history",
      "clear",
    ]) {
      expect(out).toContain(name);
    }
    expect(out).toContain("# not everything is listed.");
    expect(out).not.toContain("sudo");
  });

  it("whoami prints the tagline", async () => {
    await execute(registry, "whoami", ctx);
    expect(textOf()).toBe(deps.tagline);
  });

  it("ls lists visible files; ls -a adds dotfiles", async () => {
    await execute(registry, "ls", ctx);
    expect(textOf()).toBe(
      "about.txt  contact.txt  projects.txt  resume.pdf  work.txt",
    );
    lines.splice(0);
    await execute(registry, "ls -a", ctx);
    expect(textOf()).toContain(".plan");
  });

  it("cat prints a file", async () => {
    await execute(registry, "cat .plan", ctx);
    expect(textOf()).toContain("keep it fast. keep it boring. keep it online.");
  });

  it("cat resume.pdf prints the binary message and navigates", async () => {
    await execute(registry, "cat resume.pdf", ctx);
    expect(textOf()).toBe("resume.pdf is a binary file — opening /resume …");
    expect(navigate).toHaveBeenCalledWith("/resume");
  });

  it("cat errors: usage and no-such-file", async () => {
    await execute(registry, "cat", ctx);
    expect(textOf()).toBe("usage: cat <file>");
    lines.splice(0);
    await execute(registry, "cat nope.txt", ctx);
    expect(textOf()).toBe("cat: nope.txt: no such file");
  });

  it("open navigates each target kind", async () => {
    await execute(registry, "open about", ctx);
    expect(navigate).toHaveBeenCalledWith("/#about");
    await execute(registry, "open resume", ctx);
    expect(navigate).toHaveBeenCalledWith("/resume");
    await execute(registry, "open github", ctx);
    expect(navigate).toHaveBeenCalledWith(deps.githubUrl);
    await execute(registry, "open email", ctx);
    expect(navigate).toHaveBeenCalledWith("mailto:j@example.com");
  });

  it("open errors: usage and unknown target", async () => {
    await execute(registry, "open", ctx);
    expect(textOf()).toBe("usage: open <target>");
    lines.splice(0);
    await execute(registry, "open mars", ctx);
    expect(textOf()).toBe(
      "open: unknown target 'mars' — targets: about, work, projects, contact, resume, github, linkedin, email",
    );
  });

  it("bare section aliases delegate to open", async () => {
    await execute(registry, "work", ctx);
    expect(navigate).toHaveBeenCalledWith("/#work");
    expect(registry.get("work")?.hidden).toBe(true);
  });

  it("pwd, echo, date, history, clear", async () => {
    await execute(registry, "pwd", ctx);
    expect(textOf()).toBe("/home/jimmy");
    lines.splice(0);

    await execute(registry, 'echo hello "big world"', ctx);
    expect(textOf()).toBe("hello big world");
    lines.splice(0);

    await execute(registry, "date", ctx);
    expect(textOf()).toContain("2026");
    lines.splice(0);

    await execute(registry, "history", ctx);
    expect(textOf()).toBe("  1  help\n  2  ls");
    lines.splice(0);

    lines.push({ segments: [{ text: "junk" }], kind: "output" });
    await execute(registry, "clear", ctx);
    expect(lines).toEqual([]);
  });

  it("exports open target names for completion", () => {
    expect(OPEN_TARGET_NAMES).toEqual([
      "about",
      "work",
      "projects",
      "contact",
      "resume",
      "github",
      "linkedin",
      "email",
    ]);
  });
});
