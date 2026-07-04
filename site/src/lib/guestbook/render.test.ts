import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestbookEntry } from "../api/types";
import { renderEntries } from "./render";

// jsdom/happy-dom are not available in this workspace and dependencies are
// frozen, so these tests drive renderEntries against a minimal hand-rolled
// DOM that records exactly which tags/text nodes it creates — enough to
// prove the anti-XSS guarantee structurally without a real DOM to serialize.
class FakeNode {
  readonly tagName: string;
  children: FakeNode[] = [];
  className = "";
  data = "";

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [...nodes];
  }
}

function installDom(): { createdTags: string[] } {
  const createdTags: string[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      createdTags.push(tag);
      return new FakeNode(tag);
    },
    createTextNode: (data: string) => {
      const node = new FakeNode("#text");
      node.data = data;
      return node;
    },
  });
  return { createdTags };
}

function asListEl(el: FakeNode): HTMLElement {
  return el as unknown as HTMLElement;
}

function makeEntry(overrides: Partial<GuestbookEntry> = {}): GuestbookEntry {
  return { id: 1, name: "ada", message: "hi", ts: 1_000_000, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderEntries", () => {
  it("renders entries in the given order, newest-first as handed to it", () => {
    installDom();
    const list = new FakeNode("ul");
    const entries = [
      makeEntry({ id: 3, name: "newest", message: "third" }),
      makeEntry({ id: 2, name: "middle", message: "second" }),
      makeEntry({ id: 1, name: "oldest", message: "first" }),
    ];

    renderEntries(asListEl(list), entries, 1_000_000);

    expect(list.children).toHaveLength(3);
    const names = list.children.map((li) => {
      const meta = li.children[0] as FakeNode;
      return (meta.children[0] as FakeNode).data;
    });
    expect(names[0]).toContain("newest");
    expect(names[1]).toContain("middle");
    expect(names[2]).toContain("oldest");
  });

  it("builds each entry from fixed li/span/p tags with the right classes", () => {
    installDom();
    const list = new FakeNode("ul");
    renderEntries(asListEl(list), [makeEntry()], 1_000_000);

    const li = list.children[0] as FakeNode;
    expect(li.tagName).toBe("LI");
    const meta = li.children[0] as FakeNode;
    const msg = li.children[1] as FakeNode;
    expect(meta.tagName).toBe("SPAN");
    expect(meta.className).toBe("gb-meta");
    expect(msg.tagName).toBe("P");
    expect(msg.className).toBe("gb-msg");
  });

  it("keeps hostile name/message strings out of markup — text nodes only, no attacker-derived tags", () => {
    const { createdTags } = installDom();
    const list = new FakeNode("ul");
    const hostileStrings = [
      "<img src=x onerror=alert(1)>",
      "<script>alert(1)</script>",
      "]]>",
      "\x1b[31m",
      "‮evil",
    ];

    for (const hostile of hostileStrings) {
      renderEntries(
        asListEl(list),
        [makeEntry({ name: hostile, message: hostile })],
        1_000_000,
      );

      const li = list.children[0] as FakeNode;
      const meta = li.children[0] as FakeNode;
      const msg = li.children[1] as FakeNode;

      // the message paragraph's only child is a single text node carrying
      // the raw string byte-for-byte — proves createTextNode, never innerHTML
      expect(msg.children).toHaveLength(1);
      expect(msg.children[0]?.tagName).toBe("#TEXT");
      expect(msg.children[0]?.data).toBe(hostile);

      // the name reaches the meta line the same way — never parsed as markup
      expect(meta.children[0]?.data).toContain(hostile);
    }

    expect(createdTags.every((tag) => ["li", "span", "p"].includes(tag))).toBe(
      true,
    );
    expect(createdTags).not.toContain("img");
    expect(createdTags).not.toContain("script");
  });

  it("replaces rather than appends on a second call", () => {
    installDom();
    const list = new FakeNode("ul");
    renderEntries(asListEl(list), [makeEntry({ id: 1 })], 1_000_000);
    expect(list.children).toHaveLength(1);

    renderEntries(
      asListEl(list),
      [makeEntry({ id: 2 }), makeEntry({ id: 3 })],
      1_000_000,
    );
    expect(list.children).toHaveLength(2);
  });

  it("renders an empty list without throwing", () => {
    installDom();
    const list = new FakeNode("ul");
    expect(() => renderEntries(asListEl(list), [], 1_000_000)).not.toThrow();
    expect(list.children).toHaveLength(0);
  });

  it("wires relTime into the meta line (golden)", () => {
    installDom();
    const list = new FakeNode("ul");
    const now = 1_000_000;
    renderEntries(
      asListEl(list),
      [makeEntry({ name: "ada", ts: now - 300 })],
      now,
    );

    const li = list.children[0] as FakeNode;
    const meta = li.children[0] as FakeNode;
    expect((meta.children[0] as FakeNode).data).toBe("ada · 5min ago");
  });
});
