FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY site/package.json site/package.json
COPY api/package.json api/package.json
COPY e2e/package.json e2e/package.json
RUN npm ci -w api
COPY api api
RUN npm run -w api build

FROM node:24-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY site/package.json site/package.json
COPY api/package.json api/package.json
COPY e2e/package.json e2e/package.json
RUN npm ci -w api --omit=dev

# Bakes the DB-IP Country Lite database (CC-BY 4.0 — attribution UI ships
# separately) into the image so geo.ts has a real lookup in production.
# DBIP_SKIP=1 skips the download entirely for offline dev builds. A failed
# download/gunzip leaves api/geo/ empty rather than failing the build, so a
# deploy is never blocked on download.db-ip.com being unreachable.
FROM node:24-slim AS geo
WORKDIR /repo
ARG DBIP_SKIP=0
RUN mkdir -p api/geo && \
    if [ "$DBIP_SKIP" = "1" ]; then \
      echo "WARNING: DBIP_SKIP=1 set — skipping DB-IP download"; \
    else \
      apt-get update && \
      apt-get install -y --no-install-recommends curl ca-certificates && \
      rm -rf /var/lib/apt/lists/* && \
      month="$(date +%Y-%m)" && \
      url="https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz" && \
      if curl -fL --retry 3 -o /tmp/dbip.mmdb.gz "$url" && gunzip -c /tmp/dbip.mmdb.gz > api/geo/dbip-country-lite.mmdb; then \
        rm -f /tmp/dbip.mmdb.gz; \
      else \
        echo "WARNING: DB-IP download failed for ${url} — shipping api image without a country database"; \
        rm -f /tmp/dbip.mmdb.gz api/geo/dbip-country-lite.mmdb; \
      fi; \
    fi

FROM node:24-slim
WORKDIR /repo
ENV NODE_ENV=production
ARG COMMIT=dev
ENV COMMIT=$COMMIT
COPY --from=deps /repo/node_modules node_modules
# Supplies "type": "module" so node runs dist/ as ESM.
COPY api/package.json api/package.json
COPY --from=build /repo/api/dist api/dist
COPY --from=geo /repo/api/geo api/geo/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/dist/index.js"]
