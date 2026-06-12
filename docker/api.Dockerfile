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

FROM node:24-slim
WORKDIR /repo
ENV NODE_ENV=production
ARG COMMIT=dev
ENV COMMIT=$COMMIT
COPY --from=deps /repo/node_modules node_modules
# Supplies "type": "module" so node runs dist/ as ESM.
COPY api/package.json api/package.json
COPY --from=build /repo/api/dist api/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/dist/index.js"]
