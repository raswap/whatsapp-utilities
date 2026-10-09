# syntax=docker/dockerfile:1.7
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/connector-web/package.json packages/connector-web/
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm build && pnpm prune --prod

FROM node:22-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 ca-certificates tini \
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
