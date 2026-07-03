import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubResponse } from "../api/types";
import { decorateCards } from "./cards";

// jsdom/happy-dom are not available in this workspace and dependencies are
// frozen, so these tests drive decorateCards against a minimal hand-rolled
// DOM implementing only the surface it touches (see terminal/dom.test.ts).
class FakeEl {
  readonly tagName: string;
  children: FakeEl[] = [];
  className = "";
  data = ""; // populated for #text nodes only
  private readonly attrs = new Map<string, string>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }
}

function installDom(): void {
  const doc = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => {
      const node = new FakeEl("#text");
      node.data = text;
      return node;
    },
  };
  vi.stubGlobal("document", doc);
}

function asRoot(el: FakeEl): ParentNode {
  return el as unknown as ParentNode;
}

function repoFixture(overrides: Partial<GithubResponse["repos"][number]> = {}) {
  return {
    name: "jimmymishan.com",
    description: null,
    stars: 12,
    language: "TypeScript",
    pushed_at: "2026-07-01T12:00:00.000Z",
    url: "https://github.com/jimmyMsh/jimmymishan.com",
    fork: false,
    ...overrides,
  };
}

function makeCard(repoName: string | null): FakeEl {
  const card = new FakeEl("article");
  if (repoName !== null) card.setAttribute("data-github-repo", repoName);
  return card;
}

describe("decorateCards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // pushed 3h before "now" so relTime resolves to a known bucket
    vi.setSystemTime(new Date("2026-07-01T15:00:00.000Z"));
    installDom();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("appends exactly the meta line to a matching card", () => {
    const root = new FakeEl("div");
    const card = makeCard("jimmymishan.com");
    root.append(card);
    const data: GithubResponse = { fetched_at: 1, repos: [repoFixture()] };

    const count = decorateCards(asRoot(root), data);

    expect(count).toBe(1);
    expect(card.children).toHaveLength(1);
    const meta = card.children[0];
    expect(meta?.tagName).toBe("P");
    expect(meta?.children).toHaveLength(1);
    const textNode = meta?.children[0];
    expect(textNode?.tagName).toBe("#TEXT");
    expect(textNode?.data).toBe("★ 12 · TypeScript · pushed 3h ago");
  });

  it("leaves a non-matching card untouched", () => {
    const root = new FakeEl("div");
    const matching = makeCard("jimmymishan.com");
    const nonMatching = makeCard("some-other-repo");
    root.append(matching, nonMatching);
    const data: GithubResponse = { fetched_at: 1, repos: [repoFixture()] };

    const count = decorateCards(asRoot(root), data);

    expect(count).toBe(1);
    expect(nonMatching.children).toHaveLength(0);
  });

  it("returns 0 and leaves the DOM unchanged when repos is empty", () => {
    const root = new FakeEl("div");
    const card = makeCard("jimmymishan.com");
    root.append(card);
    const data: GithubResponse = { fetched_at: null, repos: [] };

    const count = decorateCards(asRoot(root), data);

    expect(count).toBe(0);
    expect(card.children).toHaveLength(0);
  });

  it("does not duplicate the meta line on a second call", () => {
    const root = new FakeEl("div");
    const card = makeCard("jimmymishan.com");
    root.append(card);
    const data: GithubResponse = { fetched_at: 1, repos: [repoFixture()] };

    const first = decorateCards(asRoot(root), data);
    const second = decorateCards(asRoot(root), data);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(card.children).toHaveLength(1);
  });

  it("builds the meta line from text nodes only, not parsed markup", () => {
    const root = new FakeEl("div");
    const card = makeCard("jimmymishan.com");
    root.append(card);
    const data: GithubResponse = { fetched_at: 1, repos: [repoFixture()] };

    decorateCards(asRoot(root), data);

    const meta = card.children[0];
    for (const node of meta?.children ?? []) {
      expect(node.tagName).toBe("#TEXT");
    }
  });
});
