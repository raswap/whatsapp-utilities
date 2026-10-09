# syntax=docker/dockerfile:1.7
FROM node:25-slim AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/connector-web/package.json packages/connector-web/
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages packages
# pnpm prune refuses to purge node_modules without a TTY unless CI is set.
ENV CI=true
RUN pnpm build && pnpm prune --prod

FROM node:25-slim
ENV NODE_ENV=production
# Debian bookworm ships client 15; pg_dump must match the Postgres 16 server, so use the PGDG repo.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --uid 10001 wamcp
WORKDIR /app
COPY --from=build --chown=wamcp:wamcp /app /app
USER wamcp
VOLUME ["/data"]
ENV WAMCP_DATA_DIR=/data
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "node", "packages/cli/dist/index.js"]
CMD ["serve"]
