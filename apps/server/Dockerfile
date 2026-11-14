# Build context is the repo root. The image runs as the non-root `node` user.
# It contains the bundled server plus the merchant PWA (/app/) and the SANDBOX customer simulator (/sim/).
# Production needs JAAY_MASTER_KEY and JAAY_BASE_URL (https) at run time; see docs/DEPLOY.md.
# NOT RUN: Docker is not installed on the machine this was written on.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/pos/package.json apps/pos/
COPY apps/customer-sim/package.json apps/customer-sim/
RUN pnpm install --frozen-lockfile --filter @jaay/server... --filter @jaay/pos... --filter @jaay/customer-sim...
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/pos apps/pos
COPY apps/customer-sim apps/customer-sim
# server: one esbuild bundle (no node_modules at runtime); pos and sim: static Vite builds
RUN pnpm --filter @jaay/server build && pnpm --filter @jaay/pos build && pnpm --filter @jaay/customer-sim build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/jaay.sqlite JAAY_POS_DIR=/app/pos JAAY_SIM_DIR=/app/sim
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /repo/apps/server/dist/server.mjs ./server.mjs
COPY --from=build --chown=node:node /repo/apps/pos/dist ./pos
COPY --from=build --chown=node:node /repo/apps/customer-sim/dist ./sim
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","server.mjs"]
