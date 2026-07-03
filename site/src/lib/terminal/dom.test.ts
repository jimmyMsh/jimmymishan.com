import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTerminal } from "./dom";
import type { TerminalPayload } from "./types";

// jsdom/happy-dom are not available in this workspace and dependencies are
// frozen, so these tests drive initTerminal against a minimal hand-rolled DOM
// that implements only the surface initTerminal touches.
class FakeEl {
  readonly tagName: string;
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  className = "";
  textContent = "";
  hidden = false;
  autocomplete = "";
  autocapitalize = "";
  spellcheck = true;
  scrollTop = 0;
  scrollHeight = 0;
  data = "";
  replacedCount = 0;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  append(...nodes: FakeEl[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeEl[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
    this.replacedCount++;
  }
  remove(): void {
    const siblings = this.parent?.children;
    if (siblings) {
      const i = siblings.indexOf(this);
      if (i >= 0) siblings.splice(i, 1);
    }
    this.parent = null;
  }
  addEventListener(): void {}
  focus(): void {}

  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeEl | null {
    return this.children.at(-1) ?? null;
  }
  get childElementCount(): number {
    return this.children.length;
  }
}

function installDom(reducedMotion: boolean): void {
  const doc = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (data: string) => {
      const node = new FakeEl("#text");
      node.data = data;
      return node;
    },
  };
  const win = {
    matchMedia: () => ({ matches: reducedMotion }),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  // prefetchStatus reaches for the global fetch; make it fail fast so the
  // autoplay live step is absent and init is not blocked on a real request.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("no network in tests"))),
  );
}

function makePayload(): TerminalPayload {
  return {
    tagline: "production engineer",
    email: "jimmy@example.com",
    githubUrl: "https://github.com/jimmyMsh",
    linkedinUrl: "https://linkedin.com/in/jimmy",
    files: [],
  };
}

function asRoot(el: FakeEl): HTMLElement {
  return el as unknown as HTMLElement;
}

describe("initTerminal init order", () => {
  beforeEach(() => {
    installDom(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("leaves the root's previous children intact when a build step throws", async () => {
    const root = new FakeEl("div");
    const hero = new FakeEl("p");
    root.append(hero);

    const payload = makePayload();
    Object.defineProperty(payload, "tagline", {
      get() {
        throw new Error("boom");
      },
    });

    await expect(initTerminal(asRoot(root), payload)).rejects.toThrow("boom");
    expect(root.children).toEqual([hero]);
    expect(root.replacedCount).toBe(0);
  });
});

describe("initTerminal screen-reader semantics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps completed lines in a role=log region that is not hidden (reduced motion)", async () => {
    installDom(true);
    const root = new FakeEl("div");
    root.append(new FakeEl("p"));

    await initTerminal(asRoot(root), makePayload());

    const output = root.children[0];
    expect(output?.getAttribute("role")).toBe("log");
    expect(output?.getAttribute("aria-hidden")).toBeNull();
    expect(output?.childElementCount).toBeGreaterThan(0);
    for (const line of output?.children ?? []) {
      expect(line.getAttribute("aria-hidden")).toBeNull();
    }
  });

  it("hides the animated intro from assistive tech, then reveals the final transcript", async () => {
    vi.useFakeTimers();
    installDom(false);
    const root = new FakeEl("div");
    root.append(new FakeEl("p"));

    await initTerminal(asRoot(root), makePayload());

    const output = root.children[0];
    expect(output?.getAttribute("aria-hidden")).toBe("true");

    await vi.advanceTimersByTimeAsync(5000);

    expect(output?.getAttribute("aria-hidden")).toBeNull();
    expect(output?.getAttribute("role")).toBe("log");
    for (const line of output?.children ?? []) {
      expect(line.getAttribute("aria-hidden")).toBeNull();
    }
  });
});
