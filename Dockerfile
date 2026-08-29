# syntax=docker/dockerfile:1

# ---------- deps: install the full workspace (incl. native better-sqlite3) ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Toolchain so better-sqlite3 can fall back to a source build when no prebuild exists.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

# ---------- build: typecheck + test everything, then compile the client bundle ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Gate the image on the same checks CI runs (the server ships as TS source
# run via tsx, so an image build is where type errors would otherwise hide).
RUN pnpm typecheck && pnpm test && pnpm -C client build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3001 \
  DATA_DIR=/data \
  CLIENT_DIST=/app/client/dist

COPY --from=build --chown=node:node /app /app

# SQLite database + uploaded photos/logs live here; mount a volume to persist them.
# Owned by the node user so the app can run unprivileged (named volumes inherit this).
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Seed is idempotent: it skips tables that already contain rows.
# `exec` makes the server PID 1's child so `docker stop` (SIGTERM) shuts it down gracefully.
CMD ["sh", "-c", "pnpm -C server seed && exec pnpm -C server start"]
