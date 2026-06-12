# jimmymishan.com

Personal site: a static Astro frontend and a small Hono API, shipped as Docker
images from CI to a single VPS. No builds happen on the server.

## Layout

| Path | What |
|---|---|
| `site/` | Astro (static output) |
| `api/` | Hono on @hono/node-server, port 3000 |
| `e2e/` | Playwright smoke tests |
| `docker/` | Image definitions for both deployables |
| `nginx/` | NGINX config baked into the site image |
| `scripts/` | VPS bootstrap + SQLite backup |

## Development

Requires Node 24 (`nvm use`) and Docker with compose v2.

    npm ci
    npm run -w site dev      # site on :4321
    npm run -w api dev       # api on :3000
    docker compose up --build  # full stack on :8080/:8443

## Checks

    npm run check   # biome + typecheck (site, api)
    npm test        # vitest (site, api)
    npm run build
    npm run e2e     # playwright against the built site

## Deployment

Every push to `main`: full checks → both images pushed to GHCR (`latest` +
commit SHA) → deploy job (enabled via the `DEPLOY_ENABLED` repo variable)
copies `compose.prod.yaml` + `scripts/` to the VPS and runs
`docker compose pull && up -d`. Rollback: re-run the workflow with a previous
SHA as the `tag` input. A fresh VPS is provisioned with
`scripts/vps-bootstrap.sh`; nightly SQLite backups run from cron with age and
size-capped rotation.
