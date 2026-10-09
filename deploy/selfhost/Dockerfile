# syntax=docker/dockerfile:1.7
# Self-hosted Sealed relay (spec §9.5): the same Worker bundle as Cloudflare, on workerd via Miniflare.
# Build from the repository root:
#   docker build -f deploy/selfhost/Dockerfile -t sealed-relay:local .
# Behind a TLS-intercepting proxy, pass its CA as a build secret (never stored in image layers):
#   docker build --secret id=extra_ca,src=/path/to/ca.pem -f deploy/selfhost/Dockerfile -t sealed-relay:local .

# ---------------------------------------------------------------- build: bundle the Worker with wrangler
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm install -g --no-audit --no-fund pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY services/relay/package.json services/relay/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --filter @sealed/relay...
COPY packages/core packages/core
COPY services/relay services/relay
RUN pnpm --filter @sealed/relay build

# ---------------------------------------------------------------- runtime: Miniflare + workerd
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SEALED_DATA_DIR=/data \
    SEALED_BUNDLE=/app/relay/index.js \
    SEALED_MIGRATIONS_DIR=/app/migrations \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/selfhost/server/package.json deploy/selfhost/server/package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY deploy/selfhost/server/server.mjs ./
COPY --from=build /repo/services/relay/dist/index.js /app/relay/index.js
COPY services/relay/migrations /app/migrations
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/v1/health" || exit 1
CMD ["node", "server.mjs"]
