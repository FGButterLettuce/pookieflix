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

## Open Questions / Known Limitations

- **Subtitle approach on iOS**: `<track>` + `playsInline` works in Safari's inline player and in AVPlayer fullscreen. The imperative `appendChild` workaround avoids the React/iOS `MEDIA_ERR_SRC_NOT_SUPPORTED` bug. Burn-in (ffmpeg transcode at upload time) is the nuclear option if track-based subtitles remain problematic.
- **Rate adjustment convergence**: For slow-device drift < 1.5s, rate correction (0.97x/1.03x) is gentle but slow. No known issue currently.
- **BUFFERING 20s timeout**: Forces PLAY_AT after 20s even if one viewer isn't ready. May cause a brief stall on the unready client, but unsticks iOS Safari's aggressive buffering mode.
