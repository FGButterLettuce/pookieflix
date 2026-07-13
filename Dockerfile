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


# ── Stage: Build alass (subtitle sync tool) ───────────────────────────────────
FROM rust:1-alpine AS alass-build

RUN apk add --no-cache musl-dev build-base git

WORKDIR /build
RUN git clone --depth 1 --branch v2.0.0 https://github.com/kaegi/alass.git .
RUN cargo build --release --locked --package alass-cli


# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:26-alpine AS runtime

ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.7.1

RUN apk add --no-cache ffmpeg curl
COPY --from=alass-build /build/target/release/alass-cli /usr/local/bin/alass
RUN chmod +x /usr/local/bin/alass

# cloudflared - static binary, no build needed. The server spawns and
# manages this itself once a TUNNEL_TOKEN is configured (see server/src/tunnel.ts) -
# no separate container or manual terminal step required to expose the app.
RUN curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" \
    && chmod +x /usr/local/bin/cloudflared

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
  CMD wget -qO- http://localhost:3000/api/auth/me || exit 1

CMD ["node", "server/dist/index.js"]
