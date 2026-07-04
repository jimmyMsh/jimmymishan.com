import { ApiError, apiFetch } from "../api/client";
import type { GuestbookEntry, GuestbookResponse } from "../api/types";
import { renderEntries } from "./render";

const GUESTBOOK_PATH = "/api/guestbook";

interface GuestbookPostResponse {
  entry: GuestbookEntry;
}

function q<T extends Element>(root: HTMLElement, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`guestbook: missing ${sel}`);
  return el;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function messageForError(err: ApiError): string {
  // NGINX's own rate limiter returns an HTML 429 before the request reaches
  // the app, so `code` stays undefined even though `status` is 429 — the
  // status check catches that case too (a no-op for the app-level
  // `rate_limited` case, which hits the same copy either way).
  if (err.code === "rate_limited" || err.status === 429) {
    return "rate limit hit — try again tomorrow";
  }
  switch (err.code) {
    case "disabled":
      return "signing is closed right now";
    case "invalid":
      return err.field === "url"
        ? "links aren't allowed"
        : "that didn't go through — refresh and try again";
    default:
      return "that didn't go through — try again";
  }
}

/**
 * Hydrates the static `/guestbook` shell: one GET fetches both the recent
 * entries and a write token, then wires the sign form to POST with it. A
 * failed load leaves the error line up with no auto-retry — reloading the
 * page is the retry.
 */
export function initGuestbook(root: HTMLElement): void {
  const listEl = q<HTMLElement>(root, "#gb-list");
  const errorEl = q<HTMLElement>(root, "#gb-error");
  const formEl = q<HTMLFormElement>(root, "#gb-form");
  const nameInput = q<HTMLInputElement>(root, "#gb-name");
  const messageInput = q<HTMLTextAreaElement>(root, "#gb-message");
  const honeypot = q<HTMLInputElement>(root, "#gb-website");
  const submitBtn = q<HTMLButtonElement>(root, "#gb-submit");
  const formError = q<HTMLElement>(root, "#gb-form-error");
  const confirmEl = q<HTMLElement>(root, "#gb-confirm");

  let entries: GuestbookEntry[] = [];
  let token = "";

  // Guards against a rapid second submit firing before the button's
  // `disabled` state would otherwise block it (e.g. a fast second Enter
  // beating the first paint of the disabled state).
  let submitting = false;

  function setFormError(message: string | null): void {
    formError.textContent = message ?? "";
    formError.hidden = message === null;
  }

  async function load(): Promise<void> {
    try {
      const data = await apiFetch<GuestbookResponse>(GUESTBOOK_PATH);
      entries = data.entries;
      token = data.token;
      errorEl.hidden = true;
      renderEntries(listEl, entries, nowSec());
    } catch {
      errorEl.hidden = false;
    }
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    confirmEl.hidden = true;
    setFormError(null);
    submitBtn.disabled = true;

    apiFetch<GuestbookPostResponse>(GUESTBOOK_PATH, {
      method: "POST",
      body: {
        token,
        name: nameInput.value,
        message: messageInput.value,
        website: honeypot.value,
      },
    })
      .then(({ entry }) => {
        entries = [entry, ...entries];
        renderEntries(listEl, entries, nowSec());
        formEl.reset();
        confirmEl.textContent = `signed — thanks, ${entry.name}.`;
        confirmEl.hidden = false;
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) {
          if (err.code === "disabled") formEl.hidden = true;
          setFormError(messageForError(err));
        } else {
          setFormError("that didn't go through — try again");
        }
      })
      .finally(() => {
        submitting = false;
        submitBtn.disabled = false;
      });
  });

  void load();
}
