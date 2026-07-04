import { afterEach, describe, expect, it, vi } from "vitest";
import { initContactForm } from "./island";

// jsdom/happy-dom are not available in this workspace and dependencies are
// frozen, so these tests drive initContactForm against a minimal hand-rolled
// DOM (see terminal/dom.test.ts for the base pattern) extended with
// querySelector, a real addEventListener/dispatch pair, and a `.value` field
// — the extra surface this island touches that the terminal one doesn't.
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
  form: FakeEl;
  message: FakeEl;
  from: FakeEl;
  website: FakeEl;
  formError: FakeEl;
  submit: FakeEl;
  confirm: FakeEl;
}

function buildRoot(): Fixture {
  const root = new FakeEl("section");
  const form = el("form", "contact-form");
  form.hidden = true;
  const message = el("textarea", "contact-message");
  const from = el("input", "contact-from");
  const website = el("input", "contact-website");
  const formError = el("p", "contact-form-error");
  formError.hidden = true;
  const submit = el("button", "contact-submit");
  form.append(message, from, website, formError, submit);
  const confirm = el("p", "contact-confirm");
  confirm.hidden = true;
  root.append(form, confirm);
  return { root, form, message, from, website, formError, submit, confirm };
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

// Flushes every pending microtask in the island's fetch -> fetch -> render
// chain; a macrotask boundary runs after all queued microtasks, which a bare
// `await Promise.resolve()` chain can't guarantee for a 3+ deep `.then` chain.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const TOKEN_RESPONSE = { token: "tok123" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initContactForm", () => {
  it("unhides the form on init", () => {
    const fx = buildRoot();
    initContactForm(asRoot(fx.root));
    expect(fx.form.hidden).toBe(false);
  });

  it("happy path: GET write-token then POST contact, swaps in the sent line", async () => {
    const fx = buildRoot();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return Promise.resolve(
          path === "/api/write-token"
            ? jsonResponse(TOKEN_RESPONSE)
            : jsonResponse({ sent: true }),
        );
      }),
    );
    initContactForm(asRoot(fx.root));
    fx.message.value = "hello there";
    fx.from.value = "ada@example.com";

    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(calls[0]?.path).toBe("/api/write-token");
    expect(calls[1]?.path).toBe("/api/contact");
    expect(calls[1]?.init?.method).toBe("POST");
    const body = JSON.parse(calls[1]?.init?.body as string);
    expect(body).toEqual({
      token: "tok123",
      message: "hello there",
      from: "ada@example.com",
      website: "",
    });
    expect(fx.form.hidden).toBe(true);
    expect(fx.confirm.hidden).toBe(false);
    expect(fx.confirm.textContent).toBe("sent. i read these — thanks.");
  });

  it("includes the honeypot value verbatim in the POST body", async () => {
    const fx = buildRoot();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return Promise.resolve(
          path === "/api/write-token"
            ? jsonResponse(TOKEN_RESPONSE)
            : jsonResponse({ sent: true }),
        );
      }),
    );
    initContactForm(asRoot(fx.root));
    fx.message.value = "hi";
    fx.website.value = "bot-filled";

    fx.form.dispatch("submit");
    await flush();
    await flush();

    const body = JSON.parse(calls[1]?.init?.body as string);
    expect(body.website).toBe("bot-filled");
  });

  it("disables the submit button during flight so a rapid second submit issues only one POST", async () => {
    const fx = buildRoot();
    let releaseToken: (() => void) | undefined;
    const fetchSpy = vi.fn((path: string) => {
      if (path === "/api/write-token") {
        return new Promise<Response>((resolve) => {
          releaseToken = () => resolve(jsonResponse(TOKEN_RESPONSE));
        });
      }
      return Promise.resolve(jsonResponse({ sent: true }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    initContactForm(asRoot(fx.root));
    fx.message.value = "hi";

    fx.form.dispatch("submit");
    expect(fx.submit.disabled).toBe(true);
    fx.form.dispatch("submit"); // rapid second click before the token settles
    releaseToken?.();
    await flush();
    await flush();

    const postCalls = fetchSpy.mock.calls.filter(
      ([path]) => path === "/api/contact",
    );
    expect(postCalls).toHaveLength(1);
    expect(fx.submit.disabled).toBe(false);
  });

  it.each([
    ["rate_limited", 429, "rate limit hit — try again tomorrow"],
    ["delivery_failed", 502, "couldn't send — email me instead"],
  ])("maps error code %s to its pinned inline copy and keeps the form usable", async (code, status, want) => {
    const fx = buildRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/write-token"
            ? jsonResponse(TOKEN_RESPONSE)
            : jsonResponse({ error: code }, status),
        ),
      ),
    );
    initContactForm(asRoot(fx.root));
    fx.message.value = "hi";

    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(fx.formError.textContent).toBe(want);
    expect(fx.formError.hidden).toBe(false);
    expect(fx.form.hidden).toBe(false);
    expect(fx.submit.disabled).toBe(false);
  });

  it("maps an NGINX-layer 429 (non-JSON body, code undefined) to the rate-limit copy", async () => {
    const fx = buildRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/write-token"
            ? jsonResponse(TOKEN_RESPONSE)
            : nonJsonResponse(429),
        ),
      ),
    );
    initContactForm(asRoot(fx.root));
    fx.message.value = "hi";

    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(fx.formError.textContent).toBe(
      "rate limit hit — try again tomorrow",
    );
    expect(fx.formError.hidden).toBe(false);
  });

  it("maps a network failure (no error code) to the same couldn't-send copy", async () => {
    const fx = buildRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network"))),
    );
    initContactForm(asRoot(fx.root));
    fx.message.value = "hi";

    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(fx.formError.textContent).toBe("couldn't send — email me instead");
    expect(fx.form.hidden).toBe(false);
  });

  it("maps disabled (503) on submit to the closed copy and hides the form entirely", async () => {
    const fx = buildRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/write-token"
            ? jsonResponse(TOKEN_RESPONSE)
            : jsonResponse({ error: "disabled" }, 503),
        ),
      ),
    );
    initContactForm(asRoot(fx.root));
    fx.message.value = "hi";

    fx.form.dispatch("submit");
    await flush();
    await flush();

    expect(fx.form.hidden).toBe(true);
    expect(fx.confirm.hidden).toBe(false);
    expect(fx.confirm.textContent).toBe(
      "messages are closed right now — email works",
    );
  });
});
