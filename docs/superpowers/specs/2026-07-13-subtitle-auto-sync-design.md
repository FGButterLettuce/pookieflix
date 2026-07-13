# Subtitle Auto-Sync Design

## Problem

Subtitles fetched from OpenSubtitles (or uploaded by hand) are frequently timed a few seconds off from the actual video — different disc cut, different framerate, different release than what was indexed. Today the only fix is manually searching for a better-matching release or uploading a different file.

## Goal

Add a one-click "Sync subtitles" action that automatically realigns the currently-applied subtitle to the video's actual audio track, using [alass](https://github.com/kaegi/alass) (audio-based, language-agnostic subtitle alignment). Typical runtime: ~15-30 seconds for a full movie, independent of length.

## Non-goals

- Continuous/live re-sync during playback (drift correction while watching). This is a real, much larger feature (would need an in-browser voice-activity detector against the live audio stream) with no off-the-shelf library equivalent to alass for the batch case. Out of scope here.
- Automatic sync without user action. Explicitly rejected in favor of a manual trigger — most fetched subtitles are already correctly timed, so running this on every fetch/upload would be wasted work most of the time.
- Per-viewer or per-device sync state. Not needed — see architecture below.

## Key architectural fact

Subtitles in this app are stored as a single `.vtt` sidecar file per library video (`<video>.mp4.vtt`), served identically to every viewer of a room via `GET /api/subtitle/:token` → `subtitlePath(resolvedMediaPath)`. There is no per-viewer or per-device subtitle state. This means syncing the shared file once, server-side, fixes it for every current and future viewer of that video — mobile and desktop alike — with no coordination mechanism needed between the two synchronized viewers.

## Architecture

Three touch points, no new services:

1. **Dockerfile** — add a `RUN` step downloading the static `alass` Linux binary (matching the image's existing multi-arch amd64/arm64 build) alongside the existing ffmpeg install. This is PookieFlix's real distribution path (`ghcr.io/fgbutterlettuce/pookieflix`, auto-built on push to `main`) — the dependency must live here, not just be installed ad hoc on any one deployment.
2. **Server** (`server/src/subtitles.ts` + `server/src/routes.ts`) — a `syncSubtitles(videoPath, filename)` function using the same `spawn`-based child-process pattern as `ffmpeg.ts`'s `applyFastStart`/`generateHLS`. Two new routes, both `requireAdmin` and rate-limited like the existing subtitle routes:
   - `POST /api/library/:filename/subtitles/sync`
   - `POST /api/library/:filename/subtitles/sync/undo`
3. **Client** (`client/src/pages/Room.tsx`) — a "Sync subtitles" button next to the existing subtitle controls (search/remove), a syncing spinner state, and an "Undo sync" affordance once a backup exists.

## Server-side sync flow

`syncSubtitles`:
- 404 if no `.vtt` currently exists for this video.
- Reject (same as the existing fetch-in-flight guard) if a sync is already running for this path.
- Copy the current `.vtt` → `.vtt.presync.bak`, overwriting any older backup (single-level undo).
- Spawn `alass <videoPath> <currentVtt> <tempOutputPath>`. Exact subtitle-format handling (alass native `.vtt` support vs. an `.srt` round-trip via the existing `srtToVtt` conversion, reversed) is resolved at implementation time — an implementation detail, not a design decision.
- On success: atomically rename the temp output over the real `.vtt`.
- On any failure (alass missing/non-zero exit/timeout — same `HLS_TIMEOUT_MS`-style guard pattern, ~2 minute ceiling since alass normally takes ~30s): leave the backup in place, leave the original `.vtt` untouched, return an error. No partial or corrupt subtitle is ever served.

`undoSync`:
- If `.vtt.presync.bak` exists: restore it over `.vtt`, then delete the backup (so a second undo is a no-op — single-level undo, matching the reversibility decision).
- 404 if there's nothing to undo.

## Client UI

In `Room.tsx`'s subtitle controls area: a "Sync subtitles" button, shown only when `subtitleUrl` is set (a subtitle is actually applied — no point syncing nothing). Clicking it:
- Sets a `syncing` local state (spinner, disabled button) for the ~15-30s wait.
- On success: cache-busts `subtitleUrl` the same way `applySub` already does (`?v=${Date.now()}`) so the `<track>` element reloads the corrected file, and reveals an "Undo sync" option.
- On error: surfaces inline in the same area existing subtitle-search errors would show.

## Deployment

Ships via the normal path: build → push to `main` → GHCR auto-publish, available to every self-hoster via `docker pull`.

twogether-box's own bare-metal instance (`~/watchtogether` running `node dist/index.js` directly, not via Docker, currently behind `main` and still pointing at the old `watchtogether` GitHub remote) is out of date and not on Docker at all. Bringing it current — and deciding whether to finally move it onto the Docker image like every other self-hoster, or rebuild in place — is a separate follow-up task after this feature is built and tested, not part of this design.

## Testing

No existing automated test coverage exists for the ffmpeg-adjacent features (thumbnail/HLS generation aren't unit-tested either) — this stays manual verification, consistent with how the rest of the media pipeline is tested:
- Real movie + a deliberately time-shifted subtitle → confirm alass corrects it.
- Confirm the backup/undo round-trip.
- Confirm a missing/failing `alass` binary fails safely without touching the live `.vtt`.

Per standing practice, no commit until manually tested and confirmed working.
