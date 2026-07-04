import { ApiError, apiFetch } from "../api/client";
import type { TokenResponse } from "../api/types";
import { type LiveDeps, unreachableLine } from "./live";
import type { Command, CommandContext, Line } from "./types";
import { errorLine, link, text } from "./types";

const WRITE_TOKEN_PATH = "/api/write-token";

/** Pulls `--flag value` out of `args` (from any position) and joins the
 *  remaining tokens into the message — the parser has already split quoted
 *  arguments into single tokens, so this is the only reassembly needed. */
function parseWriteArgs(
  args: string[],
  flag: string,
): { message: string | undefined; flagValue: string | undefined } {
  const rest: string[] = [];
  let flagValue: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      flagValue = args[++i];
      continue;
    }
    rest.push(args[i] as string);
  }
  return { message: rest.length > 0 ? rest.join(" ") : undefined, flagValue };
}

function mapWriteError(cmd: "sign" | "msg", err: ApiError): Line {
  // NGINX's own rate limiter returns an HTML 429 before the request reaches
  // the app, so `code` stays undefined even though `status` is 429 — the
  // status check catches that case too (a no-op for the app-level
  // `rate_limited` case, which hits the same copy either way).
  if (err.code === "rate_limited" || err.status === 429) {
    return errorLine(`${cmd}: rate limit hit — try again tomorrow`);
  }
  switch (err.code) {
    case "disabled":
      return errorLine(
        cmd === "sign"
          ? "sign: signing is closed right now"
          : "msg: messages are closed right now",
      );
    case "delivery_failed":
      return errorLine(
        "msg: couldn't deliver — email jimmymishan2004@gmail.com instead",
      );
    case "invalid":
      if (cmd === "sign" && err.field === "url") {
        return errorLine("sign: links aren't allowed in the guestbook");
      }
      // the error-body contract makes `field` optional even on "invalid" —
      // fall back to a field-less phrasing rather than printing "undefined".
      return errorLine(
        err.field
          ? `${cmd}: that didn't validate — ${err.field}`
          : `${cmd}: that didn't validate`,
      );
    default:
      return unreachableLine(cmd);
  }
}

async function fetchWriteToken(
  ctx: CommandContext,
  fetchFn: typeof fetch | undefined,
): Promise<string> {
  const { token } = await apiFetch<TokenResponse>(WRITE_TOKEN_PATH, {
    signal: ctx.signal,
    fetchFn,
  });
  return token;
}

async function runWrite(
  cmd: "sign" | "msg",
  ctx: CommandContext,
  post: (token: string) => Promise<void>,
  fetchFn: typeof fetch | undefined,
): Promise<void> {
  try {
    const token = await fetchWriteToken(ctx, fetchFn);
    await post(token);
  } catch (err) {
    if (err instanceof ApiError) {
      if (ctx.signal.aborted) return;
      ctx.writer.writeLine(mapWriteError(cmd, err));
      return;
    }
    throw err;
  }
}

export function makeSignCommand(deps: LiveDeps): Command {
  return {
    name: "sign",
    summary: "sign the guestbook",
    run(ctx, args) {
      const { message, flagValue: by } = parseWriteArgs(args, "--by");
      if (message === undefined) {
        ctx.writer.writeLine(errorLine('usage: sign "message" [--by name]'));
        return Promise.resolve();
      }
      const name = by ?? "anonymous";
      return runWrite(
        "sign",
        ctx,
        async (token) => {
          await apiFetch("/api/guestbook", {
            method: "POST",
            body: { token, name, message },
            signal: ctx.signal,
            fetchFn: deps.fetchFn,
          });
          ctx.writer.writeLine(text(`signed — thanks, ${name}.`));
          ctx.writer.writeLine({
            segments: [{ text: "see it: " }, link("/guestbook", "/guestbook")],
            kind: "hint",
          });
        },
        deps.fetchFn,
      );
    },
  };
}

export function makeMsgCommand(deps: LiveDeps): Command {
  return {
    name: "msg",
    summary: "send me a message",
    run(ctx, args) {
      const { message, flagValue: from } = parseWriteArgs(args, "--from");
      if (message === undefined) {
        ctx.writer.writeLine(
          errorLine('usage: msg "text" [--from you@example.com]'),
        );
        return Promise.resolve();
      }
      return runWrite(
        "msg",
        ctx,
        async (token) => {
          const body: Record<string, unknown> = { token, message };
          if (from !== undefined) body.from = from;
          await apiFetch("/api/contact", {
            method: "POST",
            // The server waits up to 5s on Discord delivery; allow margin over
            // that so a slow-but-successful send isn't aborted client-side
            // (which would show a false failure and invite a duplicate send).
            timeoutMs: 7000,
            body,
            signal: ctx.signal,
            fetchFn: deps.fetchFn,
          });
          ctx.writer.writeLine(text("sent. i read these — thanks."));
        },
        deps.fetchFn,
      );
    },
  };
}
