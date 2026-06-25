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

---

## Milestone 9 — Password Auth, Subtitle Modal, Adaptive Buffer Messages

> **Status: ✅ Deployed**

Three independent features landed together.

---

### 9a — Password Auth (replaced admin key)

**Problem:** The previous auth model used a shared `ADMIN_KEY` header that had to be stored in `localStorage` and sent manually on every request. Ugly, stateless, and easy to lose.

**Solution:** Password auth with session cookies.

**Server: `server/src/auth.ts`** (new file — all primitives, no deps beyond Node built-ins)

```typescript
hashPassword(password)          // crypto.scrypt, 64-byte salt, stored as "salt:hash"
verifyPassword(password, stored) // timing-safe compare
signSession(secret)              // base64url payload (exp: 7d) + HMAC-SHA256 sig
verifySession(token, secret)     // validates sig + expiry
getSessionToken(cookieHeader)    // parses wt_session= out of Cookie header
makeSessionCookie(token)         // HttpOnly; SameSite=Strict; Path=/; Max-Age=604800
clearSessionCookie()             // Max-Age=0
```

**Config:** `config.ts` — replaced `adminKey` with `passwordHash` and `sessionSecret`. Both read from `config.json` (persisted) or env vars.

**Initial setup:** `PASSWORD_HASH` written to `config.json` at first run via `/api/setup`. Existing installs can be seeded manually:

```bash
node -e "
const {hashPassword} = require('./server/dist/auth');
console.log(hashPassword('yourpassword'));
"
# paste output into data/config.json as PASSWORD_HASH
```

**Routes added:**

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/auth/me` | none | Returns `{ authed: bool }` — used to decide whether to show login |
| `POST /api/auth/login` | none | Verifies password, sets `wt_session` cookie |
| `POST /api/auth/logout` | session | Clears cookie |
| `POST /api/auth/change-password` | session | Re-hashes, rotates session secret, re-issues cookie |

**Critical bug fixed — Fastify preHandler hang:**

The `requireAdmin` hook was synchronous with 2 parameters `(req, reply)`. Fastify's `hookRunnerGenerator` passes `next` as the 3rd argument. A sync hook that doesn't call `next()` and returns `void` causes Fastify to wait forever — the `hookIterator` checks if the return is a Promise; `undefined` means it never resolves. All `/api/library` requests hung indefinitely.

Fix: make `requireAdmin` `async`. An `async` function always returns a Promise, which Fastify awaits correctly.

```typescript
// WRONG — hangs forever
function requireAdmin(req, reply) {
  if (!authed) reply.status(401).send(...); // returns void, next() never called
}

// CORRECT
async function requireAdmin(req, reply) {
  if (!authed) { await reply.status(401).send(...); }
}
```

**Client:** `Home.tsx` — `authed: boolean | null` state (null=loading, false=show login card, true=show library). Login sends `POST /api/auth/login` with password; success sets `authed=true`. All fetch calls drop `x-admin-key` header; cookies are automatic on same-origin requests. `Settings.tsx` — password change section added.

---

### 9b — Adaptive Buffer Messages

**Problem:** When buffering stalls repeatedly, the `bufferResumeThreshold` adapts upward (BUFFERING state waits for more data before resuming). Users saw increasing pauses with no explanation.

**Solution:** Show transparent messages on the buffering overlay explaining what's happening and why.

**Stall tracking (`client/src/pages/Room.tsx`):**

```typescript
const stallCountRef = useRef(0);      // cumulative stalls this session
const lastPlayStartRef = useRef(0);   // wall-clock when PLAYING was last entered
```

On `ROOM_UPDATE`:
- If state becomes `PLAYING`: record `lastPlayStartRef = Date.now()`
- If state becomes `BUFFERING`:
  - Stalled in < 12s of play → `stallCount++` (quick re-stall)
  - Previous play lasted > 25s → `stallCount = max(0, stallCount - 1)` (decay)

Overlay messages by stall count:

| Count | Message |
|---|---|
| 0 | *(default buffering message)* |
| 1–2 | "Buffering more data than usual to keep things smooth." |
| 3–4 | "Connection looks a bit slow — giving the buffer more runway." |
| 5+ | "Waiting for a larger buffer to avoid interruptions. Hang tight." |

---

### 9c — Subtitle Modal + Upload + Search

**Problem:** The subtitle UX was an inline card on the library grid, cramped and unusable.

**Solution:** Full modal (`sub-modal-overlay` → `sub-modal`) opened per file.

**Modal sections:**

1. **Status row** — green/grey dot + "Subtitles active" / "No subtitles" + Auto-pick + Remove buttons.

2. **Currently active** — if a subtitle is loaded, shown as the first item in the results list with a green left border and "✓ Active" badge. Falls back to the video filename (minus `.mp4`) when the subtitle name wasn't stored (backfill below).

3. **Upload your own** — drag-drop zone accepting `.srt` or `.vtt`. SRT is converted to VTT server-side via `srtToVtt()`. Stored next to the video as `filename.mp4.vtt`.

4. **Search OpenSubtitles** — pre-filled with the raw filename minus `.mp4` extension (no title guessing, no space normalisation). Auto-searches on modal open. Results show movie name + release label; "Use" applies the subtitle and stores its name.

**Subtitle name storage:**

`subtitle_name TEXT` column added to `library_meta` via migration:
```sql
ALTER TABLE library_meta ADD COLUMN subtitle_name TEXT DEFAULT NULL
```
`setSubtitleName(filename, name)` does an upsert so it works for files dropped in manually (no prior DB row). On library scan, if a file has a `.vtt` but `subtitle_name IS NULL`, it's backfilled to `filename.replace(/\.mp4$/, '')` — so the active subtitle name is always populated.

**Language flag:** The configured `SUBTITLE_LANG` (default `en`) is returned by `GET /api/config` as `subtitleLang`. A `langFlag()` helper maps language codes to flag emojis. The CC button on each card shows `CC ✓ 🇬🇧` (or relevant flag) when a subtitle is loaded. All search results are filtered to `subtitleLang` so there's no per-result flag.

**`fetchSubtitles` return value changed:** was `boolean`, now `string | null` — returns the chosen subtitle label so the route can call `setSubtitleName` in a `.then()` without a circular import (`db` → `subtitles` → `db`).

**Upload route fix:** The loop variable `part` goes out of scope after `break`. The original code referenced `part.filename` after the loop (would have thrown). Fixed by storing `uploadedName` inside the loop before breaking.

---

## Milestone 10 — Security Hardening, Sync Fixes, and Correctness Patches

> **Status: ✅ Deployed**

Post-review fixes across security, data integrity, sync engine, and UX.

---

### 10a — Security

**Stored XSS in log viewer (`server/src/routes.ts`)**

`POST /api/debug/logs` is intentionally unauthenticated (clients push logs without a session). The inline log viewer HTML rendered user-supplied `device` and `level` fields via `innerHTML` without escaping, and `level` was injected directly into a class attribute. An attacker on the network could POST a crafted `level` value to break out of the attribute and execute script when an admin opened `/api/debug/logs`.

Fix: added an `_e()` HTML-escape helper inside `addEntry`; `level` is now allowlisted to `info|warn|error|debug` before use in the class string.

**Empty `SESSION_SECRET` allows HMAC token forgery (`server/src/config.ts`, `routes.ts`, `index.ts`)**

If `PASSWORD_HASH` was seeded manually (per the DEVELOPMENT.md instructions) without also setting `SESSION_SECRET`, the HMAC key defaulted to `""`. Node.js accepts an empty HMAC key, so an attacker who knows the token format could compute a valid session token without the password.

Fixes:
- Server now exits at startup with a clear error if `PASSWORD_HASH` is set but `SESSION_SECRET` is missing.
- `requireAdmin` and `/api/auth/login` fail-closed with 503 if `sessionSecret` is empty at runtime.
- `requireAdmin` now has an explicit `return` after each early-exit branch for clarity.

**Manual install note:** When seeding `PASSWORD_HASH` by hand, you must also set `SESSION_SECRET` to a random 32-byte hex string. The easiest path is to use the UI's Settings → Change Password flow, which generates and persists both values automatically.

```bash
# Generate a session secret manually if needed:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Add as SESSION_SECRET in data/config.json
```

**Thumbnail endpoint exposed without auth (`routes.ts:293`)**

`GET /api/library/:filename/thumb` was served to unauthenticated callers. An attacker could enumerate library filenames by probing thumbnail URLs. Fixed by adding `preHandler: requireAdmin`.

---

### 10b — Data Integrity

**`renameLibraryFile` lost `subtitle_name` and was non-atomic (`server/src/db.ts`)**

The INSERT…SELECT that copies the metadata row on rename explicitly listed columns and omitted `subtitle_name`, so the subtitle label was silently cleared on every rename. Additionally, the INSERT and DELETE ran as separate statements — a crash between them would leave ghost rows.

Fix: `subtitle_name` added to the column list; both statements (plus the room-record UPDATE) wrapped in an explicit `BEGIN`/`COMMIT`/`ROLLBACK` transaction.

**`change-password` wrote config twice (`server/src/routes.ts`)**

`writePersistedConfig` was called once for `PASSWORD_HASH` and again for `SESSION_SECRET`. A crash between the two writes would leave the new hash saved but the old secret intact, invalidating the freshly issued cookie. Both fields are now set before the single write.

**`.vtt` subtitle uploads bypassed normalization (`routes.ts`)**

The upload handler called `srtToVtt()` only for `.srt` files. A `.vtt` file missing the mandatory `WEBVTT` header was written verbatim; browsers rejected it silently. `srtToVtt` already short-circuits if the content starts with `WEBVTT`, so calling it unconditionally is safe and fixes the malformed-VTT case.

**`srtToVtt` regex didn't handle `MM:SS,mmm` timestamps (`server/src/subtitles.ts`)**

The pattern `/(\d+:\d+:\d+),(\d+)/g` required exactly three colon-separated groups (HH:MM:SS). Some SRT files use two-group timestamps (MM:SS). Changed to `/(\d+:\d+(?::\d+)?),(\d+)/g`.

---

### 10c — Sync Engine

**Disconnect during `SEEKING` didn't pause the remaining viewer (`server/src/roomStateMachine.ts`)**

`handleViewerDisconnect` only sent a `PAUSE` broadcast for `PLAYING`, `BUFFERING`, and `RESYNCING` states. If a viewer disconnected mid-seek, the remaining viewer kept playing while the server waited in `WAITING_FOR_VIEWERS`. Fixed by adding `'SEEKING'` to the list.

**Ended detection used inferred heuristic instead of `video.ended` (`types.ts`, `videoController.ts`, `roomStateMachine.ts`)**

The server inferred video completion from `paused && bufferedAhead === 0 && readyState >= 1`. This could false-positive in the ~500ms window after a seek near end-of-file, when `serverCommandPending` clears before `PLAY_AT` arrives.

Fix: `ended: boolean` (from `HTMLMediaElement.ended`) added to `ClientHeartbeat`. The state machine now checks `hb.ended` directly; the old multi-condition heuristic is removed.

**Stale-viewer eviction threshold too aggressive (`server/src/roomManager.ts`)**

The eviction window for dropping a viewer who fails to heartbeat before allowing a third party to take their slot was 1500ms — only 3 missed heartbeats at the 500ms interval, with no allowance for jitter. Raised to 2500ms (5 missed heartbeats), which still evicts truly dead connections quickly but survives normal network jitter.

---

### 10d — Performance

**`listLibraryFiles` made N per-file database queries (`server/src/db.ts`)**

`listLibraryFiles` issued one `SELECT * FROM library_meta WHERE filename = ?` per `.mp4` file inside a `.map()`. For a library with N files this was N round-trips, re-preparing the same statement each time, on every `/api/library` poll.

Fix: replaced with a single `SELECT * FROM library_meta` up front, loaded into a `Map` keyed by filename, then looked up O(1) per file.

---

### 10e — UX

**Setup wizard advanced to "all set" before save confirmed (`client/src/pages/Setup.tsx`)**

`onClick` called `void finish()` (async, fire-and-forget) and `setStep(4)` simultaneously. If the POST failed, the user saw the success screen with no error. Fixed: `setStep(4)` moved inside `finish()`, called only on success. Errors now show correctly on the subtitles step where the user can retry.

**Disconnect overlay showed wrong message mid-session (`client/src/pages/Room.tsx`)**

When a peer left during an active session, `WAITING_FOR_VIEWERS` triggered the initial "waiting for them to show up" overlay with the invite-link flow — indistinguishable from the cold-start state. Added `peerEverJoinedRef` (set when `viewerCount >= 2` first arrives) to differentiate: mid-session disconnects now show **"they disconnected — paused until they're back"** with a "copy link" button in case they need to rejoin.
