FROM node:22.18-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22.18-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="XIVI" \
      org.opencontainers.image.description="Self-hosted photo social network"

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/xivi.sqlite

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist

RUN mkdir -p /app/data/uploads && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server-dist/index.js"]
