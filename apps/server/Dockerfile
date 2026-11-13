# Build context is the repo root. The image runs as the non-root `node` user.
# Production needs JAAY_MASTER_KEY and BASE_URL (https) set at run time.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @jaay/server...
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
# esbuild bundle: writes apps/server/dist/server.mjs, no node_modules needed at runtime
RUN pnpm --filter @jaay/server build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/jaay.sqlite
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /repo/apps/server/dist/server.mjs ./server.mjs
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","server.mjs"]
