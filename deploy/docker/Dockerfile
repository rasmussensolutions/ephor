FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock .bun-version ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/website/package.json ./apps/website/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
RUN bun scripts/download-daemon.ts && bun run --filter @ephor/dashboard build && bun run --filter @ephor/server build

FROM postgres:18-bookworm
LABEL org.opencontainers.image.source="https://github.com/rasmussensolutions/ephor"
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
RUN groupadd --gid 1000 bun && useradd --uid 1000 --gid bun --create-home bun
WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=bun:bun /app/apps/dashboard/dist/client ./apps/dashboard/dist/client
COPY --from=build --chown=bun:bun /app/packages/api/migrations ./packages/api/migrations
COPY --chmod=755 deploy/panel/entrypoint.sh /usr/local/bin/ephor-entrypoint
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3002 EPHOR_ASSETS_DIR=apps/dashboard/dist/client EPHOR_MANAGED_INSTALL=1
EXPOSE 3002
ENTRYPOINT ["ephor-entrypoint"]
CMD ["bun", "apps/server/dist/index.js"]
