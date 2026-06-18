# Uses Node.js 26 (matches dev environment; has stable built-in sqlite)
# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:26-alpine AS client-build

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci --quiet

COPY client/ ./
RUN npm run build


# ── Stage 2: Build server ─────────────────────────────────────────────────────
FROM node:26-alpine AS server-build

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --quiet

COPY server/ ./
RUN npm run build


# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:26-alpine AS runtime

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Server production deps only
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev --quiet

# Built artifacts
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    MEDIA_DIR=/data/media \
    DB_PATH=/data/app.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/library || exit 1

CMD ["node", "server/dist/index.js"]
