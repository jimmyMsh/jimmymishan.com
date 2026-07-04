import type { GuestbookEntry } from "../api/types";
import { relTime } from "../format/time";

/**
 * Rebuilds the entries list from scratch on every call, in the order given
 * (the caller owns ordering). Every runtime value — name, message — reaches
 * the DOM only via createTextNode; nothing here is ever parsed as markup.
 */
export function renderEntries(
  listEl: HTMLElement,
  entries: readonly GuestbookEntry[],
  nowSec: number,
): void {
  listEl.replaceChildren();
  for (const entry of entries) {
    const li = document.createElement("li");

    const meta = document.createElement("span");
    meta.className = "gb-meta";
    meta.append(
      document.createTextNode(`${entry.name} · ${relTime(entry.ts, nowSec)}`),
    );

    const message = document.createElement("p");
    message.className = "gb-msg";
    message.append(document.createTextNode(entry.message));

    li.append(meta, message);
    listEl.append(li);
  }
}
