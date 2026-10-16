# Fairquery Sanctions & Watchlist Screener stdio MCP server. Build context = repository root.
# This is the Dockerfile Glama uses. The Apify Actor image lives at .actor/Dockerfile.
FROM node:22-alpine AS builder
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json* ./
RUN npm install --omit=optional
COPY mcp/tsconfig.json ./
COPY mcp/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY mcp/package.json mcp/package-lock.json* ./
RUN npm install --omit=dev --omit=optional \
    && rm -rf /root/.npm
COPY --from=builder /app/dist ./dist
# APIFY_TOKEN is optional at start; required only for the main tool
USER node
CMD ["node", "dist/index.js"]
