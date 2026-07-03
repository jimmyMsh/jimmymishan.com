import type { CommandRegistry } from "./registry";
import type { Command, CommandContext } from "./types";
import { errorLine, hint, text } from "./types";

export interface CommandDeps {
  tagline: string;
  email: string;
  githubUrl: string;
  linkedinUrl: string;
}

export const OPEN_TARGET_NAMES = [
  "about",
  "work",
  "projects",
  "contact",
  "resume",
  "github",
  "linkedin",
  "email",
];

const SECTION_ALIASES = ["about", "work", "projects", "contact", "resume"];

export function createCommands(
  registry: CommandRegistry,
  deps: CommandDeps,
): Command[] {
  const targets: Record<string, string> = {
    about: "/#about",
    work: "/#work",
    projects: "/#projects",
    contact: "/#contact",
    resume: "/resume",
    github: deps.githubUrl,
    linkedin: deps.linkedinUrl,
    email: `mailto:${deps.email}`,
  };

  function openTarget(ctx: CommandContext, name: string): void {
    const url = targets[name];
    if (url === undefined) {
      ctx.writer.writeLine(
        errorLine(
          `open: unknown target '${name}' — targets: ${OPEN_TARGET_NAMES.join(", ")}`,
        ),
      );
      return;
    }
    ctx.writer.writeLine(text(`opening ${name} …`));
    ctx.navigate(url);
  }

  const commands: Command[] = [
    {
      name: "help",
      summary: "list commands",
      run(ctx) {
        for (const cmd of registry.listed()) {
          ctx.writer.writeLine(text(`${cmd.name.padEnd(10)}${cmd.summary}`));
        }
        ctx.writer.writeLine(hint("# not everything is listed."));
      },
    },
    {
      name: "whoami",
      summary: "one line about me",
      run(ctx) {
        ctx.writer.writeLine(text(deps.tagline));
      },
    },
    {
      name: "ls",
      summary: "list files",
      run(ctx, args) {
        ctx.writer.writeLine(
          text(ctx.vfs.list(args.includes("-a")).join("  ")),
        );
      },
    },
    {
      name: "cat",
      summary: "print a file",
      run(ctx, args) {
        const name = args[0];
        if (name === undefined) {
          ctx.writer.writeLine(errorLine("usage: cat <file>"));
          return;
        }
        const file = ctx.vfs.get(name);
        if (!file) {
          ctx.writer.writeLine(errorLine(`cat: ${name}: no such file`));
          return;
        }
        if (file.binary) {
          ctx.writer.writeLine(text(file.binary.message));
          ctx.navigate(file.binary.navigateTo);
          return;
        }
        for (const line of file.lines) ctx.writer.writeLine(line);
      },
    },
    {
      name: "open",
      summary: "go somewhere (open <target>)",
      run(ctx, args) {
        const name = args[0];
        if (name === undefined) {
          ctx.writer.writeLine(errorLine("usage: open <target>"));
          return;
        }
        openTarget(ctx, name);
      },
    },
    {
      name: "pwd",
      summary: "print working directory",
      run(ctx) {
        ctx.writer.writeLine(text("/home/jimmy"));
      },
    },
    {
      name: "echo",
      summary: "echo arguments",
      run(ctx, args) {
        ctx.writer.writeLine(text(args.join(" ")));
      },
    },
    {
      name: "date",
      summary: "current date and time",
      run(ctx) {
        ctx.writer.writeLine(text(ctx.now().toString()));
      },
    },
    {
      name: "history",
      summary: "command history",
      run(ctx) {
        ctx.historyList().forEach((entry, i) => {
          ctx.writer.writeLine(text(`  ${i + 1}  ${entry}`));
        });
      },
    },
    {
      name: "clear",
      summary: "clear the screen (ctrl+l)",
      run(ctx) {
        ctx.writer.clear();
      },
    },
  ];

  for (const section of SECTION_ALIASES) {
    commands.push({
      name: section,
      summary: `open ${section}`,
      hidden: true,
      run(ctx) {
        openTarget(ctx, section);
      },
    });
  }

  return commands;
}
