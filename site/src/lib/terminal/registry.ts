import { parse } from "./parser";
import type { Command, CommandContext } from "./types";
import { errorLine, text } from "./types";

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private teasers: Map<string, string>;

  constructor(teasers: Record<string, string> = {}) {
    this.teasers = new Map(Object.entries(teasers));
  }

  register(cmd: Command): void {
    this.commands.set(cmd.name, cmd);
    this.teasers.delete(cmd.name);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  listed(): Command[] {
    return [...this.commands.values()].filter((c) => !c.hidden);
  }

  completions(prefix: string): string[] {
    return this.listed()
      .map((c) => c.name)
      .filter((name) => name.startsWith(prefix))
      .sort();
  }

  teaser(name: string): string | undefined {
    return this.teasers.get(name);
  }
}

export async function execute(
  registry: CommandRegistry,
  input: string,
  ctx: CommandContext,
): Promise<void> {
  const { cmd, args } = parse(input);
  if (cmd === "") return;

  const command = registry.get(cmd);
  if (command) {
    try {
      await command.run(ctx, args);
    } catch {
      ctx.writer.writeLine(errorLine(`${cmd}: something went wrong`));
    }
    return;
  }

  const teaser = registry.teaser(cmd);
  if (teaser !== undefined) {
    ctx.writer.writeLine(text(teaser));
    return;
  }

  ctx.writer.writeLine(errorLine(`command not found: ${cmd} — try \`help\``));
}
