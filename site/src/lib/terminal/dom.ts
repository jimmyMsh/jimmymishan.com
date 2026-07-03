import { autoplayScript, finalLines } from "./autoplay";
import { createCommands, OPEN_TARGET_NAMES } from "./commands";
import { flavorCommands, TEASERS } from "./flavor";
import { registerLiveCommands } from "./live";
import { CommandRegistry, execute } from "./registry";
import type { Line, TerminalPayload, Writer } from "./types";
import { hint, text } from "./types";
import { createVfs } from "./vfs";

const MAX_LINES = 500;
const TYPE_MS = 55;

export function initTerminal(
  root: HTMLElement,
  payload: TerminalPayload,
): void {
  const vfs = createVfs(payload.files);
  const registry = new CommandRegistry(TEASERS);
  for (const cmd of createCommands(registry, payload)) registry.register(cmd);
  for (const cmd of flavorCommands()) registry.register(cmd);
  registerLiveCommands(registry);

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  root.replaceChildren();
  const output = document.createElement("div");
  output.className = "term-output";
  output.setAttribute("role", "log");
  output.setAttribute("aria-live", "polite");

  const inputRow = document.createElement("div");
  inputRow.className = "term-input-row";
  inputRow.hidden = true;
  const promptSpan = document.createElement("span");
  promptSpan.className = "prompt";
  promptSpan.textContent = "$";
  const input = document.createElement("input");
  input.className = "term-input";
  input.setAttribute("aria-label", "terminal input");
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  inputRow.append(promptSpan, input);
  root.append(output, inputRow);

  function renderLine(line: Line): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = `line line-${line.kind}`;
    if (line.kind === "echo") {
      const prompt = document.createElement("span");
      prompt.className = "prompt";
      prompt.textContent = "$ ";
      p.append(prompt);
    }
    for (const seg of line.segments) {
      if (seg.href) {
        const a = document.createElement("a");
        a.textContent = seg.text;
        a.href = seg.href;
        if (/^https?:/.test(seg.href)) {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        p.append(a);
      } else {
        p.append(document.createTextNode(seg.text));
      }
    }
    return p;
  }

  const writer: Writer = {
    writeLine(line) {
      output.append(renderLine(line));
      while (output.childElementCount > MAX_LINES) {
        output.firstElementChild?.remove();
      }
      root.scrollTop = root.scrollHeight;
    },
    replaceLast(count, lines) {
      for (let i = 0; i < count; i++) output.lastElementChild?.remove();
      for (const line of lines) this.writeLine(line);
    },
    clear() {
      output.replaceChildren();
    },
  };

  const history: string[] = [];
  let historyIndex = -1;
  let running = false;
  let runAbort: AbortController | null = null;

  function navigate(url: string): void {
    if (/^https?:/.test(url)) window.open(url, "_blank", "noopener");
    else window.location.assign(url);
  }

  function makeCtx(signal: AbortSignal) {
    return {
      writer,
      vfs,
      navigate,
      historyList: () => history,
      reducedMotion,
      signal,
      now: () => new Date(),
    };
  }

  // --- autoplay ---
  const steps = autoplayScript(payload.tagline);
  let autoplayDone = false;
  let skipAutoplay: (() => void) | null = null;

  function finishAutoplay(): void {
    if (autoplayDone) return;
    autoplayDone = true;
    writer.clear();
    for (const line of finalLines(steps)) writer.writeLine(line);
    inputRow.hidden = false;
  }

  async function playAutoplay(): Promise<void> {
    const skip = new AbortController();
    skipAutoplay = () => skip.abort();
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (skip.signal.aborted) {
          reject(new Error("skipped"));
          return;
        }
        const id = setTimeout(resolve, ms);
        skip.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(id);
            reject(new Error("skipped"));
          },
          { once: true },
        );
      });
    try {
      for (const step of steps) {
        if (step.kind === "pause") {
          await wait(step.ms);
        } else if (step.kind === "lines") {
          for (const line of step.lines) writer.writeLine(line);
        } else {
          const p = renderLine(text("", "echo"));
          const typed = document.createTextNode("");
          const cursor = document.createElement("span");
          cursor.className = "cursor";
          p.append(typed, cursor);
          output.append(p);
          for (const ch of step.text) {
            await wait(TYPE_MS);
            typed.data += ch;
          }
          cursor.remove();
        }
      }
    } catch {
      // skipped by pointerdown — finishAutoplay renders the full transcript
    }
    finishAutoplay();
  }

  if (reducedMotion) finishAutoplay();
  else void playAutoplay();

  // --- interaction ---
  root.addEventListener("pointerdown", (event) => {
    if (!autoplayDone) {
      skipAutoplay?.();
      finishAutoplay();
    }
    if (event.target instanceof HTMLAnchorElement) return;
    if (window.getSelection()?.toString()) return;
    // wait a tick so the browser doesn't move focus back on click
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  });

  function complete(): void {
    const value = input.value;
    const parts = value.split(/\s+/);
    const last = parts.at(-1) ?? "";
    let candidates: string[] = [];
    if (parts.length <= 1) {
      candidates = registry.completions(last);
    } else if (parts[0] === "cat") {
      candidates = vfs.list(false).filter((n) => n.startsWith(last));
    } else if (parts[0] === "open") {
      candidates = OPEN_TARGET_NAMES.filter((n) => n.startsWith(last)).sort();
    }
    if (candidates.length === 1 && candidates[0] !== undefined) {
      parts[parts.length - 1] = candidates[0];
      input.value = `${parts.join(" ")} `;
    } else if (candidates.length > 1) {
      writer.writeLine(hint(candidates.join("  ")));
    }
  }

  function submit(): void {
    if (running) return;
    const raw = input.value;
    input.value = "";
    writer.writeLine(text(raw, "echo"));
    if (raw.trim() !== "") history.push(raw);
    historyIndex = history.length;
    running = true;
    runAbort = new AbortController();
    void execute(registry, raw, makeCtx(runAbort.signal)).finally(() => {
      running = false;
      runAbort = null;
    });
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        input.value = history[historyIndex] ?? "";
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex < history.length) {
        historyIndex++;
        input.value = history[historyIndex] ?? "";
      }
    } else if (event.key === "Tab") {
      event.preventDefault();
      complete();
    } else if (event.key === "c" && event.ctrlKey) {
      event.preventDefault();
      runAbort?.abort();
      writer.writeLine(text("^C"));
      input.value = "";
    } else if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      writer.clear();
    }
  });
}
