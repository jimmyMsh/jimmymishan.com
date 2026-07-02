import type { Command, CommandContext, Line } from "./types";
import { text } from "./types";

export const TEASERS: Record<string, string> = {
  uptime:
    "uptime: not wired up yet — live telemetry ships in an upcoming deploy.",
  free: "free: not wired up yet — live memory stats ship in an upcoming deploy.",
  docker:
    "docker: not wired up yet — live container status ships in an upcoming deploy.",
  deploys:
    "deploys: not wired up yet — the deploy feed ships in an upcoming deploy. (yes.)",
  top: "top: not wired up yet — live process stats ship in an upcoming deploy.",
  tail: "tail: not wired up yet — live log streaming ships in an upcoming deploy.",
  status:
    "status: not wired up yet — the live dashboard ships in an upcoming deploy.",
  sign: "sign: not wired up yet — the guestbook ships in an upcoming deploy.",
  msg: "msg: not wired up yet — direct messages ship in an upcoming deploy.",
};

export function cowsayLines(message: string): string[] {
  const msg = message.length > 0 ? message : "moo";
  return [
    ` ${"_".repeat(msg.length + 2)}`,
    `< ${msg} >`,
    ` ${"-".repeat(msg.length + 2)}`,
    String.raw`        \   ^__^`,
    String.raw`         \  (oo)\_______`,
    "            (__)\\       )\\/\\",
    "                ||----w |",
    "                ||     ||",
  ];
}

const ENGINE = [
  "      ====        ________ ",
  "  _D _|  |_______/        \\__I_I_____===__|______",
  "   |(_)---  |   H\\________/ |   |        =|___ ___|",
  "   /     |  |   H  |  |     |   |         ||_| |_||",
  "  |      |  |   H  |__--------------------| [___] |",
  "  | ________|___H__/__|_____/[][]~\\_______|       |",
  "  |/ |   |-----------I_____I [][] []  D   |=======|",
];

export function slFrame(offset: number): string[] {
  return ENGINE.map((row) =>
    offset >= 0 ? " ".repeat(offset) + row : row.slice(-offset),
  );
}

function preLines(rows: string[]): Line[] {
  return rows.map((row) => text(row, "pre"));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runSl(ctx: CommandContext): Promise<void> {
  if (ctx.reducedMotion) {
    for (const line of preLines(slFrame(0))) ctx.writer.writeLine(line);
    return;
  }
  const width = Math.max(...ENGINE.map((row) => row.length));
  for (const line of preLines(slFrame(40))) ctx.writer.writeLine(line);
  try {
    for (let offset = 39; offset >= -width; offset--) {
      await delay(50, ctx.signal);
      ctx.writer.replaceLast(ENGINE.length, preLines(slFrame(offset)));
    }
  } catch {
    // aborted (ctrl+c) — the adapter prints ^C; leave the last frame
  }
}

function oneLiner(name: string, line: string): Command {
  return {
    name,
    summary: "",
    hidden: true,
    run(ctx) {
      ctx.writer.writeLine(text(line));
    },
  };
}

export function flavorCommands(): Command[] {
  return [
    {
      name: "sudo",
      summary: "",
      hidden: true,
      run(ctx) {
        ctx.writer.writeLine(text("jimmy is not in the sudoers file."));
        ctx.writer.writeLine(text("this incident will be reported."));
      },
    },
    oneLiner(
      "rm",
      "rm: refusing to remove anything — this is a production system.",
    ),
    oneLiner("exit", "exit: this terminal has no exit. it's a website."),
    oneLiner(
      "vim",
      "vim: not installed. this is a website, not a dotfiles repo.",
    ),
    oneLiner(
      "emacs",
      "emacs: not installed. (a fine operating system, missing a good editor.)",
    ),
    oneLiner(
      "nano",
      "nano: not installed. try `cat` — it never asks questions.",
    ),
    {
      name: "cowsay",
      summary: "",
      hidden: true,
      run(ctx, args) {
        for (const row of cowsayLines(args.join(" "))) {
          ctx.writer.writeLine(text(row, "pre"));
        }
      },
    },
    {
      name: "sl",
      summary: "",
      hidden: true,
      run: runSl,
    },
  ];
}
