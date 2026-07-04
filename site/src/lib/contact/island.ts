import { ApiError, apiFetch } from "../api/client";
import type { TokenResponse } from "../api/types";

const WRITE_TOKEN_PATH = "/api/write-token";
const CONTACT_PATH = "/api/contact";

const SENT_MESSAGE = "sent. i read these — thanks.";
const CLOSED_MESSAGE = "messages are closed right now — email works";
const DEFAULT_ERROR = "couldn't send — email me instead";

function q<T extends Element>(root: HTMLElement, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`contact: missing ${sel}`);
  return found;
}

function messageForError(err: ApiError): string {
  // NGINX's own rate limiter returns an HTML 429 before the request reaches
  // the app, so `code` stays undefined even though `status` is 429 — the
  // status check catches that case too (a no-op for the app-level
  // `rate_limited` case, which hits the same copy either way).
  return err.code === "rate_limited" || err.status === 429
    ? "rate limit hit — try again tomorrow"
    : DEFAULT_ERROR;
}

/**
 * Hydrates the homepage's hidden contact form: JS-off leaves today's
 * links-only #contact section as-is; JS-on reveals the form and wires
 * submit to GET /api/write-token then POST /api/contact.
 */
export function initContactForm(root: HTMLElement): void {
  const formEl = q<HTMLFormElement>(root, "#contact-form");
  const messageInput = q<HTMLTextAreaElement>(root, "#contact-message");
  const fromInput = q<HTMLInputElement>(root, "#contact-from");
  const honeypot = q<HTMLInputElement>(root, "#contact-website");
  const submitBtn = q<HTMLButtonElement>(root, "#contact-submit");
  const formError = q<HTMLElement>(root, "#contact-form-error");
  const confirmEl = q<HTMLElement>(root, "#contact-confirm");

  // Guards against a rapid second submit firing before the button's
  // `disabled` state would otherwise block it (e.g. a fast double-click
  // beating the first paint of the disabled state).
  let submitting = false;

  function setFormError(message: string | null): void {
    formError.textContent = message ?? "";
    formError.hidden = message === null;
  }

  formEl.hidden = false;

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    setFormError(null);
    submitBtn.disabled = true;

    apiFetch<TokenResponse>(WRITE_TOKEN_PATH)
      .then(({ token }) =>
        apiFetch(CONTACT_PATH, {
          method: "POST",
          // The server waits up to 5s on Discord delivery; allow margin over
          // that so a slow-but-successful send isn't aborted client-side
          // (which would show a false failure and invite a duplicate submit).
          timeoutMs: 7000,
          body: {
            token,
            message: messageInput.value,
            from: fromInput.value,
            website: honeypot.value,
          },
        }),
      )
      .then(() => {
        formEl.hidden = true;
        confirmEl.textContent = SENT_MESSAGE;
        confirmEl.hidden = false;
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "disabled") {
          formEl.hidden = true;
          confirmEl.textContent = CLOSED_MESSAGE;
          confirmEl.hidden = false;
          return;
        }
        setFormError(
          err instanceof ApiError ? messageForError(err) : DEFAULT_ERROR,
        );
      })
      .finally(() => {
        submitting = false;
        submitBtn.disabled = false;
      });
  });
}
