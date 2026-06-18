# WatchTogether — Development History

Private 2-person sync video app. Node 26 + node:sqlite, React/Vite, server-authoritative sync over WebSocket.

---

## Architecture Overview

```
Client A ──WS──┐                    ┌──WS── Client B
               └──► Server (tick) ◄─┘
```

- **Server tick** runs every 500ms, inspecting both clients' heartbeats and emitting sync commands.
- **State machine** (`roomStateMachine.ts`) owns all sync logic — clients are dumb executors.
- **Heartbeat** (`ClientHeartbeat`) reports `mediaTime`, `paused`, `seeking`, `waiting`, `readyState`, `bufferedAhead`, `playbackRate`, `serverCommandPending`.
- **`serverCommandPending`** — client sets this while applying a server command (PAUSE/SEEK/PLAY_AT). Server must ignore heartbeats in this state for buffering/drift checks, because reported `mediaTime` is stale.

### Room state machine

```
WAITING_FOR_VIEWERS
  └─► READY_CHECK (both connected)
        ├─► PLAYING (both ready)
        └─► USER_PAUSED (wasUserPaused flag)

PLAYING
  ├─► SEEKING (user scrubs)
  ├─► BUFFERING (client stalls)
  ├─► RESYNCING (drift > 1.5s)
  └─► ENDED (video finished)

BUFFERING / SEEKING / RESYNCING
  └─► PLAYING (all ready again)
        or USER_PAUSED (wasPlayingBeforeInterruption = false)

Any state → WAITING_FOR_VIEWERS (viewer disconnects)
```

---

## Milestone 1 — Initial Working Version (pre-subtitle)

> **Status: ✅ Working well — small issues only, declared "working perfectly" by user**

This is the baseline that everything else diverged from.

### What was working
- Room state machine with all states
- Two-viewer heartbeat-driven sync
- PLAY/PAUSE/SEEK user actions forwarded to server, broadcast to both clients
- Buffer-pause: if either client's `bufferedAhead < 1s`, server pauses both
- Buffer-resume: server resumes when both have `bufferedAhead >= 5s` or `readyState == 4`
- Drift correction: rate adjustment (0.97x/1.03x) for < 1.5s drift; RESYNCING seek for larger drift
- `PLAY_AT`: server sends `{ mediaTime, wallClockTime }` so both clients seek then play at the same wall-clock instant
- `wasPlayingBeforeInterruption` flag: SEEKING/BUFFERING know whether to return to PLAYING or USER_PAUSED
- `wasUserPaused` flag: USER_PAUSED state survives WebSocket reconnects
- Library: upload MP4, thumbnail generation, last-position persistence
- Remote log viewer at `/api/debug/logs` (SSE stream)

### Key config values at this point
```
bufferPauseThreshold:  1s
bufferResumeThreshold: 5s
driftIgnoreThreshold:  0.25s
driftRateThreshold:    1.5s
playAtLookaheadMs:     3000ms
heartbeatStaleMs:      5000ms
```

---

## Milestone 2 — Subtitle Support

> **Status: ⚠️ Introduced instability — this session spent debugging the fallout**

### Changes
- Added OpenSubtitles API integration (`subtitles.ts`) — auto-fetch VTT on upload
- Serve VTT at `/api/subtitle/:token`
- Client renders subtitle track via `<track>` element
- Fixed React/iOS `MEDIA_ERR_SRC_NOT_SUPPORTED` bug: moved from JSX `<track>` child to imperative `video.appendChild(track)` in `useEffect`
- Added `playsInline` to `<video>` element — **this changed iOS behavior fundamentally**:
  - Before: iOS opened native fullscreen AVPlayer (buffered fine, but JS commands couldn't control it reliably)
  - After: iOS uses inline HTML5 player (JS commands work, but buffering is more fragile under paused state)

### Side effects that caused issues downstream
The `playsInline` change exposed several latent bugs in the state machine that the native iOS player had been quietly swallowing.

---

## Milestone 3 — State Machine Bug Fixes

> **Status: ✅ Deployed — resolves rapid BUFFERING/PLAYING/RESYNCING oscillation**

### Bug 1: PLAY_AT jumping to wrong time (+30s)

**Root cause:** `buildPlayAt` called `canonicalTimeNow()` which adds `(Date.now() - canonicalTimeUpdatedAt) / 1000` to `canonicalTime`. When transitioning from SEEKING→PLAYING, `setRoomState` is called first, then `buildPlayAt` — but `canonicalTimeUpdatedAt` was set when the seek started (30s ago), so `elapsed` was ~30s.

**Fix:** `buildPlayAt` uses `room.canonicalTime` directly, not `canonicalTimeNow()`.

```typescript
// server/src/roomStateMachine.ts — buildPlayAt()
const targetTime = room.canonicalTime; // NOT canonicalTimeNow()
```

---

### Bug 2: False ENDED state immediately after PLAY_AT

**Root cause:** After `PLAY_AT` is sent, both clients are in the middle of seeking to `mediaTime`. During that seek, their heartbeats report `paused=true, bufferedAhead=0, serverCommandPending=true`. The ENDED check (`all paused && buf=0 && readyState>=1`) fired immediately.

**Fix:** Exclude clients with `serverCommandPending=true` from ENDED detection.

```typescript
// PLAYING tick — ENDED check
if (active.every(v => v.heartbeat &&
    !v.heartbeat.serverCommandPending &&   // ← added
    v.heartbeat.readyState >= 1 &&
    v.heartbeat.mediaTime > 0 &&
    v.heartbeat.paused &&
    v.heartbeat.bufferedAhead === 0)) {
  setRoomState(room, 'ENDED');
}
```

---

### Bug 3: Seek storm from applyPause

**Root cause:** When `applyPause(mediaTime)` was called while the video was already paused and a seek was in-progress, `endServerCommand()` fired immediately (before `seeked` event). With `applyingServerCommand=false`, the stray `seeked` event triggered `handleSeeking` → false `USER_ACTION SEEK` → server sent another `SEEK` → loop.

**Fix:** `applyPause` always waits for `seeked` before clearing `applyingServerCommand` when a seek is needed.

```typescript
// client/src/lib/videoController.ts — applyPause()
const needsSeek = Math.abs(this.video.currentTime - mediaTime) > 0.5;
if (needsSeek) this.video.currentTime = mediaTime;

if (this.video.paused) {
  if (needsSeek) {
    this.video.addEventListener('seeked', () => this.endServerCommand(), { once: true });
  } else {
    this.endServerCommand();
  }
} else {
  this.video.pause();
  if (needsSeek) {
    this.video.addEventListener('seeked', () => this.endServerCommand(), { once: true });
  } else {
    this.video.addEventListener('pause', () => this.endServerCommand(), { once: true });
  }
}
```

---

### Bug 4: commandTimeout expiring during seek (10s)

**Root cause:** `commandTimeout` was 3s. On slow mobile, a seek can take longer than 3s. When it expired, `applyingServerCommand` became `false` mid-seek, letting stray `pause` events through as false `USER_ACTION PAUSE` → "keeps playing and pausing" loop.

**Fix:** Increased `commandTimeout` from 3s to 10s.

```typescript
// client/src/lib/videoController.ts — beginServerCommand()
this.commandTimeout = setTimeout(() => {
  this._applyingServerCommand = false;
}, 10_000); // was 3_000
```

---

### Bug 5: isBuffering ignoring readyState 4

**Root cause:** `isBuffering` was triggering on `bufferedAhead < 1s` even when the browser reported `readyState=4` (HAVE_ENOUGH_DATA). On iOS, `bufferedAhead` can read as near-zero due to how Safari reports `buffered` ranges, but the video is actually fine.

**Fix:** Trust `readyState >= 4` as authoritative.

```typescript
function isBuffering(hb: ClientHeartbeat): boolean {
  if (hb.serverCommandPending) return false;
  if (hb.waiting) return true;
  if (hb.readyState >= 4) return false; // trust HAVE_ENOUGH_DATA
  return hb.bufferedAhead < config.bufferPauseThreshold;
}
```

---

### Bug 6: iOS not buffering while paused

**Root cause (pre-fix):** Without `playsInline`, iOS used native AVPlayer. With `playsInline`, iOS uses inline player but Safari only buffers aggressively while "playing". When paused in BUFFERING state waiting for both clients to be ready, iOS would never buffer enough to pass `bufferResumeThreshold`.

**Fix 1:** Added `playsInline` (Milestone 2) to keep video inline where JS controls work.

**Fix 2:** BUFFERING timeout — after 20s stuck with at least one client ready, force `PLAY_AT` anyway. iOS's inline player will start buffering aggressively once it receives a play command.

```typescript
// BUFFERING tick
const bufferingTimedOut =
  Date.now() - (room.bufferingStartAt ?? Date.now()) > 20_000 &&
  active.some(v => v.heartbeat && isReadyToPlay(v.heartbeat));

if (allReady || bufferingTimedOut) {
  setRoomState(room, 'PLAYING');
  dispatches.push(...buildPlayAt(room));
}
```

---

### Bug 7: RESYNCING immediately after PLAY_AT

**Root cause:** The `handleDrift` function runs every PLAYING tick. Right after `PLAY_AT` is sent, both clients report `serverCommandPending=true` — their `mediaTime` heartbeats still show their OLD position (before the seek). Desktop might be at 1341s, mobile at 1344s (the new target) → apparent drift of 3s > 1.5s threshold → RESYNCING fires immediately, sending a new SEEK that cancels the in-flight `PLAY_AT`.

**Fix:** Skip drift correction while any client has `serverCommandPending=true`.

```typescript
// PLAYING tick
if (active.every(v => !v.heartbeat?.serverCommandPending)) {
  dispatches.push(...handleDrift(room, active));
}
```

---

### Bug 8: Redundant seek inside schedulePlayAt

**Root cause:** `schedulePlayAt` correctly checked `Math.abs(currentTime - mediaTime) > 0.5` before seeking, but inside `applySeekAndWait` (the callback), `this.video.currentTime = mediaTime` was set unconditionally again. If the outer seek was already in progress, this triggered a second seek event that disrupted the buffered range.

**Fix:** Removed the redundant assignment inside `applySeekAndWait`.

---

## Milestone 4 — Sync to Slower Device on Resync

> **Status: ✅ Deployed**

**Problem:** When drift triggered a RESYNCING seek, both devices were sent to the HOST's `mediaTime`. If the host was the faster device (further ahead), the slower device was "fast-forwarded" to catch up — jarring skip on the slower device.

**Fix:** Resync to `Math.min(host.mediaTime, peer.mediaTime)` — the behind device's position. The faster device seeks back slightly; the slower device plays uninterrupted.

```typescript
// server/src/roomStateMachine.ts — handleDrift()
const targetTime = Math.min(host.heartbeat.mediaTime, peer.heartbeat.mediaTime);
```

---

## Milestone 5 — Stale Connection Eviction ("Room is full" on reconnect)

> **Status: ✅ Deployed**

**Problem:** Mobile network blips cause the WebSocket to drop without a clean close handshake. The server keeps the stale viewer in `room.viewers` until TCP times out (can be 30s+). When the mobile reconnects, `room.viewers.size` is still 2 → "Room is full (max 2 viewers)" error.

**Root cause:** `joinRoom` checked `room.viewers.size >= 2` and rejected immediately, with no check for dead connections.

**Fix:** Before rejecting, look for a viewer whose last heartbeat is older than `heartbeatStaleMs` (5s). If found, terminate their WebSocket and evict them, then allow the new connection in.

```typescript
// server/src/roomManager.ts — joinRoom()
if (room.viewers.size >= 2) {
  const now = Date.now();
  const stale = Array.from(room.viewers.values()).find(
    v => v.heartbeatAt > 0 && now - v.heartbeatAt > config.heartbeatStaleMs
  );
  if (!stale) {
    send(ws, { type: 'ERROR', message: 'Room is full (max 2 viewers)' });
    return null;
  }
  try { stale.ws.terminate(); } catch { /* ignore */ }
  room.viewers.delete(stale.viewerId);
}
```

**Why `heartbeatAt > 0`:** A viewer who just joined hasn't sent their first heartbeat yet. `heartbeatAt === 0` (never received) means "just connected", not "dead" — we give them a grace period.

---

## Milestone 6 — iOS Buffer Optimizations

> **Status: ✅ Deployed**

A cluster of changes to reduce iOS buffering and stuttering.

### WS ping interval: 2s → 15s

**Problem:** Mobile connections were stuttering increasingly over time. Traced to the 2s WebSocket ping interval: brief cell handoffs or network hiccups (~1-2s) caused `alive=false` → `ws.terminate()` → reconnect loop. Each reconnect triggered a RESYNCING seek, which flushed the buffer.

**Fix:** Raised ping interval to 15s.

```typescript
// server/src/roomManager.ts
}, 15_000); // was 2_000
```

### iOS native player (`playsInline` removed)

`playsInline` was re-removed so iOS uses its native fullscreen AVPlayer. JS sync commands still work via standard HTMLMediaElement API.

### Seek threshold: 0.5s → 2.0s

`applyPause` and `schedulePlayAt` only seek if `|currentTime - targetTime| > 2.0s`. Seeking on iOS flushes the decode buffer — a 2s tolerance avoids unnecessary flushes during normal pause/resume cycles where the server position and client position are naturally slightly different.

### `bufferPauseThreshold: 0`

Previously the server paused both clients if `bufferedAhead < 1s`. This triggered aggressive seeks that flushed the very buffer we were trying to build. Setting threshold to `0` means only actual stall events (`waiting=true`) trigger BUFFERING state.

### `driftRateThreshold: 10s`

Raised from 1.5s to 10s. Below 10s drift, only playback rate adjustment is used (0.97x/1.03x), never a RESYNCING seek. iOS buffer survives; small drift is corrected gradually.

### MP4 fast-start

Uploaded MP4s are reprocessed with `ffmpeg -movflags +faststart` to move the moov atom to the front of the file. Without this, iOS sends a second range request to the end of the file before it can start playing — visible as a double request and startup lag on slow connections.

### Cache-Control + ETag on media endpoint

```
Cache-Control: public, max-age=3600
ETag: "<size>-<mtime>"
```

iOS range requests for already-seen byte ranges return 304 from the server instead of re-sending data.

---

## Milestone 7 — HLS Streaming for iOS

> **Status: ✅ Deployed — commit ba69805**

**Problem:** Despite all optimizations, iOS Safari still buffered aggressively mid-film. Root cause: iOS's HTML5 video player is poorly optimized for long progressive MP4 downloads; it re-requests large ranges and has erratic buffering behaviour past the first few minutes.

**Solution:** Generate HLS segments (`.ts` chunks + `.m3u8` manifest) with ffmpeg at upload time. iOS Safari handles HLS natively and buffers much more efficiently.

### HLS generation (`server/src/ffmpeg.ts`)

```typescript
ffmpeg -fflags +genpts -err_detect ignore_err \
  -i video.mp4 -c copy \
  -hls_time 4 -hls_list_size 0 \
  -hls_segment_filename video.hls/seg%04d.ts \
  -y video.hls/index.m3u8
```

- **Stream copy** (`-c copy`) — no re-encode; runs at ~800x realtime on NVMe
- **`-fflags +genpts`** — regenerates presentation timestamps; required because some H.264 files (even tagged as x265 in filename) have timestamp discontinuities around the 14-minute mark that cause ffmpeg to stall indefinitely without this flag
- **`-err_detect ignore_err`** — skips past malformed packets that would otherwise cause a silent hang
- **10-minute timeout** added to `generateHLS` to kill any process that stalls despite the above flags

### Trigger points

| Event | Action |
|---|---|
| File uploaded | `generateHLSAsync(savedPath)` |
| Room created from library | `generateHLSAsync(filePath)` |
| Server startup | Scan library dir; `generateHLSAsync` for any `.mp4` missing a `.hls/` folder |

### HLS serving (`server/src/routes.ts`)

```
GET /api/hls/:token/index.m3u8
GET /api/hls/:token/seg0001.ts
```

Token validated, path confined to media dir (directory traversal check), `Content-Type: application/vnd.apple.mpegurl` or `video/mp2t`, `Cache-Control: public, max-age=3600`.

### Client selection (`client/src/pages/Room.tsx`)

```typescript
function supportsHLS(): boolean {
  const v = document.createElement('video');
  return v.canPlayType('application/vnd.apple.mpegurl') !== '';
}

// in VideoPlayer src prop:
src={roomInfo.hlsUrl && supportsHLS() ? roomInfo.hlsUrl : roomInfo.mediaUrl}
```

iOS Safari returns `'probably'` → uses HLS. Desktop Chrome/Firefox returns `''` → falls back to MP4.

### Diagnostics panel removed

The diagnostics overlay was removed from all devices in this milestone. Remote logs (`rlog`) still capture `hls=true/false` in the JOINED log line for debugging.

---

## Open Questions / Known Limitations

- **Subtitle approach on iOS**: `<track>` + imperative `appendChild` works in Safari. The JSX `<track>` child causes `MEDIA_ERR_SRC_NOT_SUPPORTED` on iOS — keep the useEffect workaround.
- **Rate adjustment convergence**: For drift < 10s, rate correction (0.97x/1.03x) is gentle but slow. No known issue currently.
- **BUFFERING 20s timeout**: Forces PLAY_AT after 20s even if one viewer isn't ready. May cause a brief stall on the unready client, but unsticks iOS Safari's aggressive buffering mode.
- **HLS for non-MP4 uploads**: Only `.mp4` files in the library dir are scanned at startup. If other formats are ever supported, `generateHLSAsync` would need to handle them.
- **Existing library files**: HLS is generated at startup for any file missing a `.hls/` folder, so existing files are covered on next server restart.

---

## Milestone 8 — LAN Upload Flow

> **Status: ✅ Deployed — commit 93623e6**

**Problem:** Large files can't be uploaded through Cloudflare (tunnel has a request size limit). The server runs on the local network at `192.168.0.91:3000` and needs a direct upload path bypassing the tunnel.

### LAN upload button

`UPLOAD_URL=http://192.168.0.91:3000` added to `.env`. When set, a yellow "Upload via local network (faster)" button appears below the upload zone on every page load — regardless of whether the user is on HTTPS or LAN. Previously gated behind `isHttps` detection which was unreliable.

### Post-upload success screen

After a file finishes uploading via the LAN interface, the page no longer auto-redirects to `localhost:3000/room/TOKEN` (which was broken — localhost means the client's own machine, not the server).

Instead the upload zone shows:
- ✓ Upload complete
- **"Watch on WatchTogether →"** — links to `APP_BASE_URL/room/TOKEN` (i.e. `https://thought.niranjanrakesh.me/room/TOKEN`)
- **"Upload another"** — resets the zone for the next file

`APP_BASE_URL=https://thought.niranjanrakesh.me` added to `.env` so all generated room URLs point to the public domain rather than localhost.

### .env

```
UPLOAD_URL=http://192.168.0.91:3000
APP_BASE_URL=https://thought.niranjanrakesh.me
```

Server must be started with `env $(cat .env | xargs) node dist/index.js` to pick these up (no dotenv dependency).
