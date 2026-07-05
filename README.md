# jimmymishan.com

My personal site — and, on purpose, a live window into its own infrastructure.
Open `/status` and you're looking at the real CPU, memory, containers, and
deploys of the box serving the page to you right now. It's a static Astro
frontend backed by a small Hono API, shipped as Docker images straight from CI
to a single 1 vCPU / 1 GB VPS. No builds ever happen on the server — if there
isn't enough headroom to build here, there isn't enough headroom to build
anywhere near it.

## Poke around

The homepage has a real terminal, not a decoration. `whoami`, `ls -a`,
`cat about.txt`, `open projects` — that sort of thing — plus a few commands
that talk to the live infrastructure over SSE (`status`, `top`, `tail -f
access.log`). Tab-completion, command history, Ctrl+C/Ctrl+L all work like
you'd expect.

It also talks back. Typo `ls` as `sl` and see what happens. Try `sudo`. Ask it
to `cowsay` something. There's a hidden file too, if you go looking with the
right flag. I'm not going to spoil the rest — `help` even says so:

```
$ help
...
# not everything is listed.
```

## What's here

- **Home** — about, work, projects, and contact, plus the terminal above.
- **`/status`** — a live dashboard: CPU/memory/latency sparklines, container
  health, a 90-day uptime bar, a deploy feed, live traffic (country-level
  only), and a presence counter. All streamed over SSE, with a polling
  fallback if a connection drops.
- **`/guestbook`** — sign it from the terminal (`sign "hi" --by you`) or the
  page itself.
- **`/resume`** — also reachable by `cat resume.pdf` in the terminal, which is
  more honest about what it's about to do than most PDFs are.
- A custom 404 that's styled as a terminal "command not found," because
  consistency matters even when you've taken a wrong turn.

## Built with

Astro 6 · Hono 4 · TypeScript (strict) · SQLite via `node:sqlite` · Vitest ·
Playwright · Biome · plain CSS with design tokens · Node ≥ 24.

## A word on abuse protection

Since the site happily exposes write endpoints (guestbook, contact) and live
infrastructure data, it leans on a few defenses I'm fairly proud of:

- Both write forms carry a **honeypot field** — real users never see or fill
  it, so anything that does gets a *fake success* response while the
  submission is quietly discarded.
- Writes require a short-lived, signed **freshness token** (2 hours), so a
  form has to have actually been loaded recently to submit.
- Per-IP and global **daily caps** on both forms, with a slot refunded if a
  delivery upstream fails partway through.
- **IPs are never stored.** On the write forms an IP only ever becomes an HMAC
  hash — never the raw address — used both as a rate-limit key and as the handle
  saved beside a guestbook entry so it can be attributed and moderated. For
  traffic stats the raw IP is resolved to a country code and then discarded, so
  the in-memory traffic buffer has no IP in it at all.
- NGINX in front does rate limiting (10 r/s on the API, 1/min on writes),
  caps concurrent SSE connections, and sets the usual hardening headers
  (HSTS, nosniff, frame-deny, referrer-policy).
- Analytics are self-hosted (GoatCounter, its own `stats.` subdomain), and
  there's an OpenMetrics endpoint at `/api/metrics` for anyone who wants the
  raw numbers.

## Repo layout

| Path | What it is |
|---|---|
| `site/` | Astro static frontend — home terminal, `/status`, `/guestbook`, `/resume`, custom 404 |
| `api/` | Hono API — status, metrics, guestbook, contact, deploy webhook, SSE hub, log tail, SLO prober; SQLite via `node:sqlite` |
| `e2e/` | Playwright end-to-end tests against the preview build |
| `docker/` | Multi-stage Dockerfiles (`site.Dockerfile` for nginx, `api.Dockerfile`) |
| `nginx/` | Production vhosts baked into the site image: apex + `stats.` subdomain, API proxy, SSE tuning, rate limits |
| `scripts/` | `vps-bootstrap.sh`, nightly `backup-sqlite.sh`, `check-bundle-size.mjs` (CI size gate) |
| `compose.yaml` / `compose.prod.yaml` | Local dev stack / production stack (GHCR images) |
| `.github/workflows/` | CI: checks → images → gated deploy |

## Running it locally

Needs Node ≥ 24 (`.nvmrc` pins `24`) and Docker with Compose v2.

```bash
npm ci
npm run -w site dev        # site on :4321
npm run -w api dev         # api on :3000
docker compose up --build  # full stack: nginx on :8080/:8443, api, goatcounter
```

Copy `.env.example` to `.env` for the API. The write endpoints, the deploy
webhook, and log tailing are each gated on their own config variable and
degrade cleanly (503) if it's unset — nothing hard-crashes for lack of a
secret.

## Checks

```bash
npm run check   # biome + astro check + tsc
npm test        # vitest, site + api
npm run build
npm run size     # gzip budget check for client islands
npm run e2e      # playwright against the preview build
```

All five run in CI and gate whether images get published at all.

## Deployment

A merge to `main` builds the `site` and `api` images and pushes them to GHCR,
tagged `latest` and with the commit SHA. If the `DEPLOY_ENABLED` repo variable
is on, CI then SSHes to the VPS, syncs `compose.prod.yaml` and `scripts/`,
pulls and restarts, health-checks `/api/healthz`, and records the deploy —
which you can watch show up on `/status` or via the terminal's `deploys`
command. Rolling back is re-running the workflow against an older image tag.
`scripts/vps-bootstrap.sh` sets up a fresh VPS from scratch; `backup-sqlite.sh`
runs nightly with age/size-capped rotation.
