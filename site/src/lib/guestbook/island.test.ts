import { afterEach, describe, expect, it, vi } from "vitest";
import { initGuestbook } from "./island";

// jsdom/happy-dom are not available in this workspace and dependencies are
// frozen, so these tests drive initGuestbook against a minimal hand-rolled
// DOM — copied from contact/island.test.ts's FakeEl harness (querySelector,
// a real addEventListener/dispatch pair, and `.value`) plus `replaceChildren`,
// which render.ts's renderEntries calls on `#gb-list`.
interface FakeEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
}

class FakeEl {
  readonly tagName: string;
  children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";

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
  replaceChildren(...nodes: FakeEl[]): void {
    this.children = [...nodes];
  }
  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string): void {
    const event: FakeEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  querySelector<T>(sel: string): T | null {
    const id = sel.replace(/^#/, "");
    return (findById(this, id) as unknown as T) ?? null;
  }
}

function findById(el: FakeEl, id: string): FakeEl | null {
  if (el.getAttribute("id") === id) return el;
  for (const child of el.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function el(tag: string, id: string): FakeEl {
  const node = new FakeEl(tag);
  node.setAttribute("id", id);
  return node;
}

interface Fixture {
  root: FakeEl;
  list: FakeEl;
  error: FakeEl;
  form: FakeEl;
  name: FakeEl;
  message: FakeEl;
  website: FakeEl;
  submit: FakeEl;
  formError: FakeEl;
  confirm: FakeEl;
}

function buildRoot(): Fixture {
  const root = new FakeEl("section");
  const list = el("ul", "gb-list");
  const error = el("p", "gb-error");
  error.hidden = true;
  const form = el("form", "gb-form");
  const name = el("input", "gb-name");
  const message = el("textarea", "gb-message");
  const website = el("input", "gb-website");
  const submit = el("button", "gb-submit");
  const formError = el("p", "gb-form-error");
  formError.hidden = true;
  form.append(name, message, website, submit, formError);
  const confirm = el("p", "gb-confirm");
  confirm.hidden = true;
  root.append(list, error, form, confirm);
  return {
    root,
    list,
    error,
    form,
    name,
    message,
    website,
    submit,
    formError,
    confirm,
  };
}

function asRoot(node: FakeEl): HTMLElement {
  return node as unknown as HTMLElement;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Mirrors NGINX's own rate limiter, which returns an HTML 429 before the
// request reaches the app — the body isn't JSON, so `code` stays undefined
// while `status` is 429 (see parseErrorBody swallowing the parse failure).
function nonJsonResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
  } as unknown as Response;
}

// Flushes every pending microtask in the island's fetch -> render chain; a
// macrotask boundary runs after all queued microtasks, which a bare `await
// Promise.resolve()` chain can't guarantee for a multi-deep `.then` chain.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const LOAD_RESPONSE = { entries: [], token: "tok123" };

function isPost(init?: RequestInit): boolean {
  return init?.method === "POST";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initGuestbook", () => {
  it("maps an NGINX-layer 429 (non-JSON body, code undefined) to the rate-limit copy", async () => {
    const fx = buildRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: RequestInit) =>
        Promise.resolve(
          isPost(init) ? nonJsonResponse(429) : jsonResponse(LOAD_RESPONSE),
        ),
      ),
    );
    initGuestbook(asRoot(fx.root));
    await flush();
    await flush();

    fx.name.value = "ada";
    fx.message.value = "hi";
    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(fx.formError.textContent).toBe(
      "rate limit hit — try again tomorrow",
    );
    expect(fx.formError.hidden).toBe(false);
  });

  it("maps an app-level rate_limited (code set) to the rate-limit copy", async () => {
    const fx = buildRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: RequestInit) =>
        Promise.resolve(
          isPost(init)
            ? jsonResponse({ error: "rate_limited" }, 429)
            : jsonResponse(LOAD_RESPONSE),
        ),
      ),
    );
    initGuestbook(asRoot(fx.root));
    await flush();
    await flush();

    fx.name.value = "ada";
    fx.message.value = "hi";
    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(fx.formError.textContent).toBe(
      "rate limit hit — try again tomorrow",
    );
    expect(fx.formError.hidden).toBe(false);
  });

  it("guards a rapid second Enter before the first POST resolves so only one POST lands", async () => {
    const fx = buildRoot();
    let releasePost: (() => void) | undefined;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        calls.push({ path, init });
        if (isPost(init)) {
          return new Promise<Response>((resolve) => {
            releasePost = () =>
              resolve(jsonResponse({ error: "rate_limited" }, 429));
          });
        }
        return Promise.resolve(jsonResponse(LOAD_RESPONSE));
      }),
    );
    initGuestbook(asRoot(fx.root));
    await flush();
    await flush();

    fx.name.value = "ada";
    fx.message.value = "hi";

    fx.form.dispatch("submit");
    expect(fx.submit.disabled).toBe(true);
    fx.form.dispatch("submit"); // rapid second Enter before the first POST resolves
    releasePost?.();
    await flush();
    await flush();

    const postCalls = calls.filter(({ init }) => isPost(init));
    expect(postCalls).toHaveLength(1);
    expect(fx.submit.disabled).toBe(false);
  });
});
