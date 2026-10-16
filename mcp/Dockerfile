# Fairquery Sanctions & Watchlist Screener stdio MCP server. Build from this directory: docker build -t fairquery-sanctions-screener-mcp .
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional \
    && rm -rf /root/.npm
COPY --from=builder /app/dist ./dist
# APIFY_TOKEN is optional at start; required only for the main tool
USER node
CMD ["node", "dist/index.js"]
