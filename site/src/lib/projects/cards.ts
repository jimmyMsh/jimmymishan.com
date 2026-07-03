import type { GithubRepo, GithubResponse } from "../api/types";
import { relTime } from "../status/format";

const META_CLASS = "project-github-meta";

function findRepoCards(root: ParentNode): Element[] {
  const cards: Element[] = [];
  const stack: Element[] = Array.from(root.children);
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: stack.length > 0 guards this pop
    const el = stack.pop()!;
    if (el.getAttribute("data-github-repo") !== null) cards.push(el);
    stack.push(...Array.from(el.children));
  }
  return cards;
}

function alreadyDecorated(card: Element): boolean {
  return Array.from(card.children).some((c) => c.className === META_CLASS);
}

function buildMetaLine(repo: GithubRepo, nowSec: number): HTMLElement {
  const pushedSec = Math.floor(new Date(repo.pushed_at).getTime() / 1000);
  const p = document.createElement("p");
  p.className = META_CLASS;
  p.append(
    document.createTextNode(
      // language is absent for some repos (e.g. docs-only) — "-" matches the
      // null-placeholder convention used elsewhere for missing metric fields
      `★ ${repo.stars} · ${repo.language ?? "-"} · pushed ${relTime(pushedSec, nowSec)}`,
    ),
  );
  return p;
}

/**
 * Decorates build-time project cards with a live GitHub meta line. Cards are
 * matched by `data-github-repo`; a card whose repo isn't in `data` is left
 * untouched. Idempotent: a card that already carries the meta line is
 * skipped, so a repeat call decorates nothing new and returns 0.
 */
export function decorateCards(root: ParentNode, data: GithubResponse): number {
  const repos = new Map(data.repos.map((r) => [r.name, r]));
  const nowSec = Math.floor(Date.now() / 1000);
  let decorated = 0;
  for (const card of findRepoCards(root)) {
    if (alreadyDecorated(card)) continue;
    const name = card.getAttribute("data-github-repo");
    const repo = name === null ? undefined : repos.get(name);
    if (!repo) continue;
    card.append(buildMetaLine(repo, nowSec));
    decorated++;
  }
  return decorated;
}
