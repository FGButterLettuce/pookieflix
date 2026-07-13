# PookieFlix

A private two-person synchronized video watching app. Upload or drop videos into your library, create a room, share the link, watch in perfect sync. Buffer-aware pausing, adaptive thresholds, and HLS streaming for mobile.

## Quick start (Docker)

**Option A: prebuilt image, no clone needed**

```bash
docker run -d --name pookieflix -p 3000:3000 \
  -v "$(pwd)/data:/data" \
  ghcr.io/fgbutterlettuce/pookieflix:latest
open http://localhost:3000
```

**Option B: build from source**

```bash
git clone https://github.com/FGButterLettuce/pookieflix.git
cd pookieflix
docker compose up --build -d
open http://localhost:3000
```

On first run the setup wizard walks you through your public URL, optional Cloudflare Tunnel, subtitles API key, and password. Everything is saved to `./data/config.json` inside the volume, so there are no config files to edit.

**Optional `.env` file**, only needed if you want to override settings without the wizard (scripted deploys, non-standard port, Cloudflare tunnel token):

```bash
cp .env.example .env
# edit what you need, then:
docker compose up --build -d
```

## How to use

### Upload a video

1. Open the app and sign in with your password.
2. Drop an MP4 into the upload zone or click to browse.
3. After upload, click **Watch on PookieFlix →** to get the room URL.
4. Share the room URL. Your partner opens it, no account needed.

### Use a video already on the server

Drop an MP4 into `./data/media/library/`:

```bash
cp ~/Videos/movie.mp4 ./data/media/library/
```

It appears in your library on the next page refresh. Thumbnails and HLS segments generate automatically in the background.

### Converting a video to MP4

Uploads must be MP4 (the server checks both the file extension and content type, and rejects anything else). If your video is in a different format, convert it first.

**Mac:** [Flixify](https://github.com/FGButterLettuce/flixify) is a free drag-and-drop app that does this without a terminal, signed, notarized, and hardware-accelerated. If you'd rather use the command line, or you're on Windows or Linux, ffmpeg does the same conversion everywhere:

1. Install ffmpeg, if you don't already have it:
   - **Mac**: `brew install ffmpeg` ([Homebrew](https://brew.sh))
   - **Windows**: `winget install ffmpeg` (or download from [ffmpeg.org](https://ffmpeg.org/download.html#build-windows) and add it to your `PATH`)
   - **Linux**: `sudo apt install ffmpeg` (Debian/Ubuntu), `sudo dnf install ffmpeg` (Fedora), or `sudo pacman -S ffmpeg` (Arch)
2. Run the conversion, pointing at your source file:
   ```bash
   ffmpeg -i input.mkv \
     -c:v libx264 -preset medium -crf 20 \
     -c:a aac -b:a 192k \
     -movflags +faststart \
     output.mp4
   ```
3. Upload `output.mp4` (or drop it into `./data/media/library/`, per above).

What the flags do: `-c:v libx264` re-encodes video to H.264 (broadly compatible); `-crf 20` sets quality (lower is better/larger, 18–28 is a reasonable range, 23–26 for smaller files); `-c:a aac` re-encodes audio to AAC; `-movflags +faststart` moves file metadata to the front of the file, which is required for the video to start playing before the whole file has downloaded.

## Authentication

The app uses password auth with a session cookie (7-day TTL, `HttpOnly; SameSite=Strict`). Set your password during the setup wizard, or change it anytime in **Settings → Change password**.

There's no account system, just one shared password since the app is private.

## Subtitles

Each library file has a **CC** button that opens the subtitle modal:

- **Auto-pick:** searches OpenSubtitles by file hash + title, downloads the best match.
- **Search:** manual search against OpenSubtitles, pre-filled with the filename.
- **Upload your own:** drag-drop `.srt` or `.vtt`. SRT is converted to VTT automatically.
- **Remove:** deletes the subtitle file.
- **Currently active:** the active subtitle always appears as the first item in the list with a "✓ Active" badge and the subtitle name.

Requires `OPENSUBTITLES_API_KEY` in your config. Subtitle language defaults to `en`; set `SUBTITLE_LANG` to change it.

## Sync behaviour

- Both viewers send a heartbeat every 500 ms (`bufferedAhead`, `paused`, `seeking`, `waiting`, etc.).
- The server is the single source of truth: all play/pause/seek commands come from it.
- **Buffering:** if either viewer stalls (`waiting=true`), both pause. Both resume when each has enough buffer (adaptive threshold, starts at 1.5 s, increases on quick re-stalls).
- **Drift < 250 ms:** ignored.
- **Drift 250 ms – 5 s:** rate nudge (0.95× / 1.05×) on the lagging viewer.
- **Drift > 5 s:** RESYNCING. Server seeks both to the behind viewer's position, then `PLAY_AT`.
- **`PLAY_AT`** carries a wall-clock timestamp 800 ms in the future so both clients start simultaneously regardless of message delivery jitter.
- **User pause:** any viewer pausing pauses the room; only a user play action resumes it.
- **Adaptive buffer messages:** the buffering overlay explains what's happening ("buffering more runway", "connection looks slow", etc.) as the adaptive threshold rises.

## iOS / mobile

iOS Safari receives HLS (`.m3u8` + `.ts` segments, generated at upload time) instead of the raw MP4. HLS buffering on iOS is significantly better than progressive MP4.

## Expose via Cloudflare Tunnel

`cloudflared` is bundled in the image — PookieFlix runs and manages the connector itself once you
give it a token. No separate container, no terminal command on the host.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Networking → Tunnels → Create a tunnel**, choose **Cloudflared**, name it anything.
2. Copy the token shown under **"Install connector"** (the long string in the command they show you — paste the whole command, or just the token, into the wizard; PookieFlix extracts the token either way, and you don't need to run that command anywhere).
3. On the tunnel's **Routes** tab, click **Add route** → **Published application** (not "Private Network", which requires the Cloudflare WARP client). Choose a subdomain/domain and set **Service URL** to `http://localhost:3000` — plain `http://`, not `https://` (Cloudflare's edge handles the public HTTPS side; PookieFlix only speaks HTTP internally).
4. Paste the token into PookieFlix's setup wizard (or **Settings → Cloudflare Tunnel token** if you've already finished setup) and set your public URL to `https://watch.yourdomain.com`.

That's it — the tunnel connects immediately and reconnects automatically across restarts. The token
is stored in `./data/config.json`, same as everything else the wizard saves.

**If port 3000 was already taken on your machine**, you likely just remapped the outside port
(`docker run -p 8080:3000 ...`) — the Service URL above is unaffected, since `cloudflared` runs
inside the same container as PookieFlix and always talks to its internal port (3000 by default),
regardless of what host port you mapped it to externally. This only matters if you *also* set a
custom `PORT` environment variable for PookieFlix itself — in that case, use that port instead of
3000 in the Service URL.

## LAN upload (bypasses Cloudflare file size limit)

Set `UPLOAD_URL=http://<server-lan-ip>:3000` in `.env`. The upload zone will use the LAN address directly for large file transfers.

## Running locally (development)

```bash
# Terminal 1 — server (watches + restarts on changes)
cd server && npm install && npm run dev

# Terminal 2 — client (Vite HMR)
cd client && npm install && npm run dev
# http://localhost:5173 — proxies /api and /ws to :3000
```

## Architecture

```
pookieflix/
├── server/src/
│   ├── index.ts              — Fastify + WebSocket bootstrap
│   ├── config.ts             — env-var config (reads data/config.json)
│   ├── auth.ts               — password hash, session sign/verify (Node crypto only)
│   ├── db.ts                 — SQLite via node:sqlite
│   ├── types.ts              — shared type definitions
│   ├── roomStateMachine.ts   — pure sync state machine (no I/O)
│   ├── roomManager.ts        — WebSocket handling + room runtime
│   ├── routes.ts             — HTTP routes
│   ├── subtitles.ts          — OpenSubtitles API + SRT→VTT conversion
│   └── ffmpeg.ts             — thumbnail + HLS generation
├── client/src/
│   ├── pages/
│   │   ├── Home.tsx          — library, upload, subtitle modal
│   │   ├── Room.tsx          — player + sync + buffering overlay
│   │   ├── Settings.tsx      — password change, config
│   │   └── Setup.tsx         — first-run wizard
│   ├── lib/
│   │   ├── videoController.ts — HTMLVideoElement wrapper
│   │   └── wsClient.ts        — WebSocket client + reconnect
│   └── components/
│       ├── VideoPlayer.tsx
│       └── RoomStatus.tsx
├── Dockerfile
├── docker-compose.yml
└── data/                     (created at runtime, mounted as volume)
    ├── app.db                 — SQLite
    ├── config.json            — persisted config (PASSWORD_HASH, SESSION_SECRET, etc.)
    └── media/
        ├── library/           — your video files
        └── rooms/             — room-scoped uploads (auto-deleted on expiry)
```

## Security

- Room tokens: 32 bytes of cryptographic random (64-char hex).
- Media served at `/api/media/:token`; only valid, non-expired tokens work.
- Path traversal prevented by resolving and checking all paths against the media root.
- Only MP4 accepted on upload; content-type and extension both checked.
- Rate limiting: 200 req/min global, 5/min upload, 10/min room creation.
- Rooms expire after `ROOM_TTL_HOURS` (default 24 h); expired files are deleted.
- Password hashed with `crypto.scrypt` (N=16384, r=8, p=1), 64-byte random salt.
- Session tokens: HMAC-SHA256 signed, 7-day expiry, `HttpOnly; SameSite=Strict` cookie.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3000` | Public URL shown in room share links |
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `../data` | Root data directory (relative to `server/`) |
| `MEDIA_DIR` | `$DATA_DIR/media` | Video storage root |
| `DB_PATH` | `$DATA_DIR/app.db` | SQLite database path |
| `MAX_UPLOAD_BYTES` | `4294967296` | Max upload size (4 GB) |
| `ROOM_TTL_HOURS` | `24` | Room / link lifetime |
| `UPLOAD_URL` | — | LAN address for large file uploads (bypasses Cloudflare) |
| `OPENSUBTITLES_API_KEY` | — | Required for subtitle auto-fetch and search |
| `SUBTITLE_LANG` | `en` | Language code for subtitle search (e.g. `fr`, `de`, `ja`) |
| `PASSWORD_HASH` | — | `scrypt` hash of the app password (set via setup wizard) |
| `SESSION_SECRET` | — | HMAC secret for session tokens (auto-generated at setup) |

## License

MIT. See [LICENSE](LICENSE).

The Docker image also bundles one GPL-3.0 third-party binary (`alass`, for
subtitle sync) — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
