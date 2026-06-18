# WatchTogether

A private two-person synchronized video watching app. Upload or select a video, create a room, share the link, watch in perfect sync with automatic buffer-aware pausing.

## Quick start (Docker)

```bash
# 1. Clone / copy the project
cd watchtogether

# 2. Copy and edit the env file
cp .env.example .env
# Edit APP_BASE_URL if you're exposing via Cloudflare Tunnel (see below)

# 3. Build and start
docker compose up --build -d

# 4. Open the app
open http://localhost:3000
```

The app stores all data under `./data/`:
- `./data/media/rooms/`   — uploaded video files (room-scoped)
- `./data/media/library/` — pre-existing videos you drop here manually
- `./data/app.db`         — SQLite room metadata

## How to use

### Upload a video and create a room

1. Open `http://localhost:3000` (or your public URL).
2. Click **Upload video**, select an MP4 file, then click **Create room**.
3. The app redirects you to the room page and shows a shareable link.
4. Copy the link (top-right button) and send it to your girlfriend.
5. She opens the link in her browser — no account, no install.

### Use a video already on the server

1. Copy the MP4 into `./data/media/library/`:
   ```bash
   cp ~/Videos/movie.mp4 ./data/media/library/
   ```
2. Open the app → click **Library** → select the file → **Create room**.

### Recommended video format

Re-encode with ffmpeg for browser compatibility:

```bash
ffmpeg -i input.mkv \
  -c:v libx264 -preset medium -crf 20 \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  output.mp4
```

Key points:
- `-movflags +faststart` moves the moov atom to the front for faster browser load.
- CRF 20 gives good quality. Use 23–26 to reduce file size.

## Expose via Cloudflare Tunnel

Cloudflare Tunnel gives your girlfriend a public HTTPS/WSS URL without port forwarding:

```bash
# Install cloudflared (Arch Linux)
yay -S cloudflared

# Login (one-time)
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create watchtogether

# Route to your local app
cloudflared tunnel route dns watchtogether watch.yourdomain.com

# Run the tunnel (or add to systemd)
cloudflared tunnel run --url http://localhost:3000 watchtogether
```

Then set in your `.env`:
```
APP_BASE_URL=https://watch.yourdomain.com
```

And rebuild:
```bash
docker compose up --build -d
```

Cloudflare handles TLS termination. WebSocket (`wss://`) works automatically.

If you don't have a custom domain, use a quick tunnel:
```bash
cloudflared tunnel --url http://localhost:3000
# Prints a random *.trycloudflare.com URL — share that as APP_BASE_URL
```

## Running locally (development)

```bash
# Terminal 1 — server
cd server
npm install
npm run dev

# Terminal 2 — client (Vite dev server with HMR)
cd client
npm install
npm run dev
# Opens at http://localhost:5173, proxies /api and /ws to :3000
```

## Sync behavior

- Both viewers send a heartbeat every 500 ms (bufferedAhead, paused, seeking, etc.).
- The server is the single source of truth. It drives all play/pause/seek commands.
- **Buffering:** if either viewer has < 2 s buffered while playing, both pause. Both resume only when each has ≥ 10 s buffered (hysteresis).
- **Drift < 250 ms:** ignored.
- **Drift 250 ms – 1.5 s:** the lagging viewer gets a `playbackRate` nudge (0.97–1.03).
- **Drift > 1.5 s:** server commands pause + seek to host position + coordinated resume.
- **User pause:** any viewer pausing pauses the room; only a user play action resumes it.
- **User seek:** server commands both viewers to seek, waits for readiness, then resumes.
- `PLAY_AT` commands carry a wall-clock timestamp 1.5 s in the future so both clients start playing simultaneously regardless of message delivery jitter.

## Architecture

```
watchtogether/
├── server/           Node.js + TypeScript + Fastify
│   └── src/
│       ├── config.ts            — env-var config
│       ├── db.ts                — SQLite (better-sqlite3)
│       ├── types.ts             — shared type definitions
│       ├── roomStateMachine.ts  — pure sync state machine
│       ├── roomManager.ts       — WebSocket + room runtime
│       ├── routes.ts            — HTTP routes (upload, media, rooms)
│       └── index.ts             — Fastify + WS server bootstrap
│   └── tests/
│       └── roomStateMachine.test.ts
├── client/           React 18 + Vite + TypeScript
│   └── src/
│       ├── lib/
│       │   ├── videoController.ts  — HTMLVideoElement wrapper
│       │   └── wsClient.ts         — WebSocket client + reconnect
│       ├── components/
│       │   ├── VideoPlayer.tsx
│       │   ├── RoomStatus.tsx
│       │   └── DiagnosticsPanel.tsx  (visible in dev mode only)
│       └── pages/
│           ├── Home.tsx    — upload / library / create room
│           └── Room.tsx    — player + sync
├── Dockerfile
├── docker-compose.yml
└── data/             (created at runtime, mounted as volume)
    ├── media/
    │   ├── rooms/    — uploaded videos, one dir per room token
    │   └── library/  — manually placed videos
    └── app.db
```

## Security notes

- Room tokens are 32 bytes of cryptographically random data (64-char hex).
- Media is served at `/api/media/:token` — only valid, non-expired tokens work.
- Path traversal is prevented by resolving and checking paths against the media root.
- Only MP4 files are accepted; content-type and extension are both checked.
- Rate limiting: global 200 req/min, upload 5/min, room creation 10/min.
- Rooms expire after `ROOM_TTL_HOURS` (default 24 h); expired room uploads are deleted.
- The library file picker validates filenames against a safe pattern (`[\w\-. ]+\.mp4`).
- All uploads are stored outside the frontend public directory.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3000` | Shown in room share links |
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `../data` | Root data directory |
| `MEDIA_DIR` | `$DATA_DIR/media` | Video storage root |
| `DB_PATH` | `$DATA_DIR/app.db` | SQLite database path |
| `MAX_UPLOAD_BYTES` | `4294967296` | Max upload size (4 GB) |
| `ROOM_TTL_HOURS` | `24` | Room / link lifetime |
