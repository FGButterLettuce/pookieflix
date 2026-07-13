# Subtitle Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Sync subtitles" action that realigns the currently-applied subtitle to the video's actual audio track using `alass`, with single-level undo.

**Architecture:** `alass` is built from source in a new Docker build stage (no usable prebuilt Linux binary exists — see Task 1) and copied into the runtime image. The server shells out to it via a `spawn`-based pattern matching the existing `ffmpeg.ts` functions, converting the app's `.vtt` subtitle to `.srt` first (alass/its `subparse` dependency don't understand WebVTT) and back afterward. Because subtitles are stored as one shared `.vtt` file per library video — not per viewer — syncing it once fixes it for every current and future viewer of that video, mobile and desktop alike.

**Tech Stack:** Rust (to build `alass` from its pinned `v2.0.0` tag, `ffmpeg-binary` feature — shells out to the `ffmpeg`/`ffprobe` already in the image, no extra system audio libs needed), Node.js/Fastify (server), React (client).

## Global Constraints

- `alass` must be added via the **Dockerfile** — this is PookieFlix's real distribution path (`ghcr.io/fgbutterlettuce/pookieflix`, auto-published on push to `main`), not just installed ad hoc on one deployment.
- Sync is **manual only** — a button the user clicks, never run automatically on fetch/upload.
- **Single-level undo**: one backup (`.vtt.presync.bak`), overwritten on each new sync; undo restores it and deletes the backup (a second undo is a no-op).
- New routes (`/api/library/:filename/subtitles/sync` and `.../sync/undo`) must use `requireAdmin` + rate limiting, matching every other subtitle route in `server/src/routes.ts`.
- On any sync failure, the live `.vtt` must be left completely untouched — no partial/corrupt subtitle is ever served.
- Per standing practice: no `git commit` of the code changes (Tasks 2–7) until manually verified working end-to-end. The spec-doc commit already made is unrelated and stands.

---

### Task 1: Verify `alass` builds from source (standalone, throwaway)

**Why this is first:** the only Linux release of `alass` (`alass-linux64`, GitHub release `v2.0.0`, 2019) is a glibc build with no `arm64` variant — unusable in this project's `node:26-alpine` (musl) multi-arch (amd64+arm64) image. Building from source is the only viable path, but it's an unverified assumption (2019 Rust code against a current toolchain) that needs checking before it's wired into the real Dockerfile. The repo does ship a committed `Cargo.lock`, so `--locked` pins exact 2019-era dependency versions rather than re-resolving against today's crates.io.

**Files:**
- Create (scratch, deleted at the end of this task): `/tmp/alass-build-check/Dockerfile`

**Interfaces:**
- Produces: confirmation that `cargo build --release --locked --package alass-cli` succeeds on `rust:1-alpine`, and the exact output binary path (`target/release/alass-cli`) — Task 2 depends on this path being correct.

- [ ] **Step 1: Write the throwaway verification Dockerfile**

```bash
mkdir -p /tmp/alass-build-check
cat > /tmp/alass-build-check/Dockerfile << 'EOF'
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev build-base git
WORKDIR /build
RUN git clone --depth 1 --branch v2.0.0 https://github.com/kaegi/alass.git .
RUN cargo build --release --locked --package alass-cli
RUN ls -la target/release/alass-cli
EOF
```

- [ ] **Step 2: Build it and confirm success**

Run: `docker build -f /tmp/alass-build-check/Dockerfile -t alass-build-check /tmp/alass-build-check`

Expected: build completes with exit code 0, and the final `ls -la target/release/alass-cli` step in the log shows a real file (a few MB, not zero bytes).

If this fails: read the actual compiler/linker error before doing anything else (per systematic-debugging) — do not skip ahead to Task 2 with a broken build assumption. Common failure shapes to expect: a transitive dependency requiring a newer Rust edition than `rust:1-alpine` ships (fix: use a specific `rust:1.75-alpine`-style pinned tag instead of the rolling `rust:1-alpine`), or `webrtc-vad`'s build script failing to find a C compiler (fix: confirm `build-base` actually installed `gcc`/`musl-gcc` — `apk add --no-cache musl-dev build-base` should cover it, but verify via the build log).

- [ ] **Step 3: Confirm the binary actually runs and prints usage**

```bash
docker run --rm alass-build-check /build/target/release/alass-cli --help
```

Expected: prints alass's CLI help text (usage, `--split-penalty`, `--no-splits`, etc.) — confirms it's not just compiled but actually executable on Alpine/musl.

- [ ] **Step 4: Clean up**

```bash
docker rmi alass-build-check
rm -rf /tmp/alass-build-check
```

---

### Task 2: Wire the verified build into the real Dockerfile

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Produces: `/usr/local/bin/alass` available in the final runtime image, invocable as `alass <reference> <input.srt> <output.srt>`. Task 4's `syncSubtitles` depends on this exact path and argument order.

- [ ] **Step 1: Add the alass build stage and copy it into the runtime stage**

In `Dockerfile`, add a new stage after the existing `client-build`/`server-build` stages (before `runtime`), and add one `COPY --from=` line plus a rename step inside the `runtime` stage:

```dockerfile
# ── Stage: Build alass (subtitle sync tool) ───────────────────────────────────
FROM rust:1-alpine AS alass-build

RUN apk add --no-cache musl-dev build-base git

WORKDIR /build
RUN git clone --depth 1 --branch v2.0.0 https://github.com/kaegi/alass.git .
RUN cargo build --release --locked --package alass-cli
```

Then in the `runtime` stage, right after the existing `RUN apk add --no-cache ffmpeg` line, add:

```dockerfile
COPY --from=alass-build /build/target/release/alass-cli /usr/local/bin/alass
RUN chmod +x /usr/local/bin/alass
```

The full `runtime` stage's top should now read:

```dockerfile
# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:26-alpine AS runtime

RUN apk add --no-cache ffmpeg
COPY --from=alass-build /build/target/release/alass-cli /usr/local/bin/alass
RUN chmod +x /usr/local/bin/alass

WORKDIR /app
```

- [ ] **Step 2: Build the full image locally and verify `alass` is present and runs**

Run: `docker build -t pookieflix-alass-test .`

Then: `docker run --rm pookieflix-alass-test alass --help`

Expected: build succeeds, and `alass --help` prints the same usage text as Task 1's verification. This confirms the binary survived the stage-to-stage copy and rename correctly.

- [ ] **Step 3: Clean up the test image**

```bash
docker rmi pookieflix-alass-test
```

(Do not commit yet — Task 7 covers the single commit for all code changes, after end-to-end verification.)

---

### Task 3: Add `vttToSrt()` conversion function, with a real unit test

**Files:**
- Modify: `server/src/subtitles.ts`
- Create: `server/tests/subtitles.test.ts`

**Interfaces:**
- Consumes: nothing new — pure string-to-string function.
- Produces: `export function vttToSrt(content: string): string` in `server/src/subtitles.ts`, used by Task 4's `syncSubtitles`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/subtitles.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vttToSrt } from '../src/subtitles';

describe('vttToSrt', () => {
  it('converts a basic multi-cue VTT to SRT', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:02.500
Hello world

2
00:00:03.000 --> 00:00:04.000 align:start position:10%
Second line
with two rows
`;
    const expected = `1
00:00:01,000 --> 00:00:02,500
Hello world

2
00:00:03,000 --> 00:00:04,000
Second line
with two rows
`;
    assert.equal(vttToSrt(vtt), expected);
  });

  it('drops cue identifiers and handles a missing WEBVTT header gracefully', () => {
    const vtt = `cue-42
00:01:00.000 --> 00:01:05.000
Only cue
`;
    const result = vttToSrt(vtt);
    assert.equal(result, `1\n00:01:00,000 --> 00:01:05,000\nOnly cue\n`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx tsx --test tests/subtitles.test.ts`

Expected: FAIL — `vttToSrt` is not exported from `../src/subtitles` (module has no such export yet).

- [ ] **Step 3: Implement `vttToSrt` in `server/src/subtitles.ts`**

Add this function right after the existing `srtToVtt` function (currently at `server/src/subtitles.ts:100-103`):

```typescript
export function vttToSrt(content: string): string {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n+/, '');
  const blocks = withoutHeader.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
  let index = 0;
  const srtBlocks = blocks.flatMap(block => {
    const lines = block.split('\n');
    const cueLineIdx = lines.findIndex(l => l.includes('-->'));
    if (cueLineIdx === -1) return [];
    index += 1;
    const timeLine = lines[cueLineIdx]
      .replace(/(\d\d:\d\d:\d\d)\.(\d\d\d)/g, '$1,$2')
      .split(' ').slice(0, 3).join(' ');
    const textLines = lines.slice(cueLineIdx + 1);
    return [`${index}\n${timeLine}\n${textLines.join('\n')}`];
  });
  return srtBlocks.join('\n\n') + '\n';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx tsx --test tests/subtitles.test.ts`

Expected: both tests PASS.

- [ ] **Step 5: Do not commit yet**

Per the Global Constraints, this is one part of a larger uncommitted change set — Task 7 does the single commit after full end-to-end verification.

---

### Task 4: Add `syncSubtitles()` and `undoSync()` to the server

**Files:**
- Modify: `server/src/subtitles.ts`

**Interfaces:**
- Consumes: `vttToSrt` (Task 3), existing `srtToVtt` and `subtitlePath` (already in this file).
- Produces:
  - `export async function syncSubtitles(videoPath: string): Promise<{ ok: true } | { ok: false; error: string }>`
  - `export function undoSync(videoPath: string): boolean`

  Task 5's routes depend on these exact names and signatures. (`backupPath` stays a private, non-exported helper — nothing outside this file needs it: the in-flight check lives inside `syncSubtitles` itself, and the client tracks its own spinner state the same way the existing `subApplying` flow already does, with no server-side "is it syncing" query.)

- [ ] **Step 1: Add the sync/undo functions**

Add this block to `server/src/subtitles.ts`, after `vttToSrt` (added in Task 3). It needs `spawn` and `path`, matching the pattern already used in `server/src/ffmpeg.ts`:

```typescript
import { spawn } from 'child_process';
```

(Add this import at the top of the file, alongside the existing `import fs from 'fs';`.)

```typescript
// ── Subtitle sync (alass) ─────────────────────────────────────────────────────

const syncInFlight = new Set<string>();
const SYNC_TIMEOUT_MS = 2 * 60 * 1000; // 2 min — alass is normally ~30s for a full movie

function backupPath(videoPath: string): string {
  return subtitlePath(videoPath) + '.presync.bak';
}

function runAlass(referencePath: string, inputSrt: string, outputSrt: string): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn('alass', [referencePath, inputSrt, outputSrt]);
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(false); }, SYNC_TIMEOUT_MS);
    proc.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export async function syncSubtitles(videoPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const vttPath = subtitlePath(videoPath);
  if (!fs.existsSync(vttPath)) return { ok: false, error: 'No subtitles to sync' };
  if (syncInFlight.has(videoPath)) return { ok: false, error: 'Sync already in progress' };

  syncInFlight.add(videoPath);
  const tmpSrtIn = vttPath + '.sync-in.srt';
  const tmpSrtOut = vttPath + '.sync-out.srt';
  try {
    fs.copyFileSync(vttPath, backupPath(videoPath));

    const vttContent = fs.readFileSync(vttPath, 'utf8');
    fs.writeFileSync(tmpSrtIn, vttToSrt(vttContent), 'utf8');

    const ok = await runAlass(videoPath, tmpSrtIn, tmpSrtOut);
    if (!ok) return { ok: false, error: 'alass failed to align subtitles' };

    const srtContent = fs.readFileSync(tmpSrtOut, 'utf8');
    fs.writeFileSync(vttPath, srtToVtt(srtContent), 'utf8');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Unexpected error during sync' };
  } finally {
    syncInFlight.delete(videoPath);
    try { fs.rmSync(tmpSrtIn); } catch { /* ignore */ }
    try { fs.rmSync(tmpSrtOut); } catch { /* ignore */ }
  }
}

export function undoSync(videoPath: string): boolean {
  const backup = backupPath(videoPath);
  if (!fs.existsSync(backup)) return false;
  fs.copyFileSync(backup, subtitlePath(videoPath));
  fs.rmSync(backup);
  return true;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`

Expected: no type errors.

- [ ] **Step 3: Do not commit yet**

Covered by Task 7.

---

### Task 5: Add the sync/undo routes

**Files:**
- Modify: `server/src/routes.ts`

**Interfaces:**
- Consumes: `syncSubtitles`, `undoSync` (Task 4), existing `assertLibraryPath`, `SAFE_FILENAME_RE`, `requireAdmin` (already in this file).
- Produces: `POST /api/library/:filename/subtitles/sync` and `POST /api/library/:filename/subtitles/sync/undo`, consumed by Task 6's client code.

- [ ] **Step 1: Update the import from `./subtitles`**

Find this line (`server/src/routes.ts:15`):

```typescript
import { fetchSubtitles, subtitlePath, searchSubtitles, extractTitle, srtToVtt } from './subtitles';
```

Replace it with:

```typescript
import { fetchSubtitles, subtitlePath, searchSubtitles, extractTitle, srtToVtt, syncSubtitles, undoSync } from './subtitles';
```

- [ ] **Step 2: Add the two routes**

Add this immediately after the existing subtitle delete route (`server/src/routes.ts:400-410`, ending with the `});` that closes the `app.delete('/api/library/:filename/subtitles', ...)` handler), and before the "Subtitle upload" section comment:

```typescript
  // ── Subtitle sync (alass) ──────────────────────────────────────────────────
  app.post('/api/library/:filename/subtitles/sync', {
    config: { rateLimit: { max: 5, timeWindow: '1m' } },
    preHandler: requireAdmin,
  }, async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!SAFE_FILENAME_RE.test(filename)) return reply.status(400).send({ error: 'Invalid filename' });
    let filePath: string;
    try { filePath = assertLibraryPath(filename); } catch { return reply.status(400).send({ error: 'Invalid path' }); }
    if (!fs.existsSync(filePath)) return reply.status(404).send({ error: 'Not found' });

    const result = await syncSubtitles(filePath);
    if (!result.ok) return reply.status(422).send({ error: result.error });
    return reply.send({ ok: true });
  });

  app.post('/api/library/:filename/subtitles/sync/undo', {
    config: { rateLimit: { max: 10, timeWindow: '1m' } },
    preHandler: requireAdmin,
  }, async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!SAFE_FILENAME_RE.test(filename)) return reply.status(400).send({ error: 'Invalid filename' });
    let filePath: string;
    try { filePath = assertLibraryPath(filename); } catch { return reply.status(400).send({ error: 'Invalid path' }); }

    const restored = undoSync(filePath);
    if (!restored) return reply.status(404).send({ error: 'Nothing to undo' });
    return reply.send({ ok: true });
  });

```

- [ ] **Step 3: Verify it compiles**

Run: `cd server && npx tsc --noEmit`

Expected: no type errors.

- [ ] **Step 4: Do not commit yet**

Covered by Task 7.

---

### Task 6: Add the client UI

**Files:**
- Modify: `client/src/pages/Room.tsx`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `POST /api/library/:filename/subtitles/sync` and `.../sync/undo` (Task 5), existing `roomInfo.mediaFilename`, `subtitleUrl`/`setSubtitleUrl`, `token` (all already in `Room.tsx`).

- [ ] **Step 1: Add local state**

In `Room.tsx`, right after the existing subtitle-related state block (`client/src/pages/Room.tsx:62-67`):

```typescript
  const [subtitleUrl, setSubtitleUrl] = useState<string | undefined>();
  const [showSubPicker, setShowSubPicker] = useState(false);
  const [subQuery, setSubQuery] = useState('');
  const [subResults, setSubResults] = useState<{ fileId: number; label: string }[]>([]);
  const [subSearching, setSubSearching] = useState(false);
  const [subApplying, setSubApplying] = useState(false);
```

add:

```typescript
  const [subSyncing, setSubSyncing] = useState(false);
  const [subSynced, setSubSynced] = useState(false);
  const [subSyncError, setSubSyncError] = useState('');
```

- [ ] **Step 2: Add the sync/undo callbacks**

Right after the existing `removeSubs` callback (`client/src/pages/Room.tsx:270-274`):

```typescript
  const removeSubs = useCallback(() => {
    setSubtitleUrl(undefined);
    setShowSubPicker(false);
    setSubResults([]);
  }, []);
```

add:

```typescript
  const syncSubs = useCallback(async () => {
    if (!roomInfo) return;
    setSubSyncing(true);
    setSubSyncError('');
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(roomInfo.mediaFilename)}/subtitles/sync`, {
        method: 'POST',
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setSubSyncError(data.error ?? 'Sync failed');
        return;
      }
      setSubSynced(true);
      setSubtitleUrl(`/api/subtitle/${token}?v=${Date.now()}`);
    } catch {
      setSubSyncError('Sync failed');
    } finally {
      setSubSyncing(false);
    }
  }, [roomInfo, token]);

  const undoSyncSubs = useCallback(async () => {
    if (!roomInfo) return;
    try {
      await fetch(`/api/library/${encodeURIComponent(roomInfo.mediaFilename)}/subtitles/sync/undo`, {
        method: 'POST',
      });
    } finally {
      setSubSynced(false);
      setSubtitleUrl(`/api/subtitle/${token}?v=${Date.now()}`);
    }
  }, [roomInfo, token]);
```

- [ ] **Step 3: Add the button/status JSX**

In the `sub-picker` block (`client/src/pages/Room.tsx:359-399`), find the closing `</div>` of `sub-picker-row` (right after the conditional "Off" button at line 373-377):

```tsx
            {subtitleUrl && (
              <button className="copy-btn sub-remove-btn" onClick={removeSubs} title="Turn off subtitles">
                Off
              </button>
            )}
          </div>
```

Replace with:

```tsx
            {subtitleUrl && (
              <button className="copy-btn sub-remove-btn" onClick={removeSubs} title="Turn off subtitles">
                Off
              </button>
            )}
            {subtitleUrl && (
              <button className="copy-btn" onClick={() => void syncSubs()} disabled={subSyncing}>
                {subSyncing ? 'Syncing…' : 'Sync subtitles'}
              </button>
            )}
          </div>
          {subSynced && (
            <p className="sub-sync-status">
              Synced. <button className="sub-sync-undo" onClick={() => void undoSyncSubs()}>Undo</button>
            </p>
          )}
          {subSyncError && <p className="sub-no-results">{subSyncError}</p>}
```

- [ ] **Step 4: Add minimal CSS for the new status line**

In `client/src/index.css`, right after the existing `.sub-no-results` rule (find it with `grep -n "sub-no-results" client/src/index.css`), add:

```css
.sub-sync-status { font-size: 0.85rem; color: var(--muted); padding: 4px 0; }
.sub-sync-undo { background: none; border: none; color: var(--accent); text-decoration: underline; cursor: pointer; padding: 0; font-size: inherit; }
```

- [ ] **Step 5: Verify it builds**

Run: `cd client && npm run build`

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 6: Do not commit yet**

Covered by Task 7.

---

### Task 7: End-to-end manual verification, then commit

**Files:** none (verification only), then a single commit covering Tasks 2–6.

- [ ] **Step 1: Build the full image**

Run: `docker build -t pookieflix-sync-test .`

Expected: succeeds (this now includes the alass stage from Task 2 plus the server/client changes from Tasks 3-6).

- [ ] **Step 2: Run it against a real test library**

Use a short local test clip and a deliberately-offset subtitle (shift a real `.srt`'s timestamps by a few seconds, convert with the existing `srtToVtt`, drop it in as `<testfile>.mp4.vtt` in a scratch `MEDIA_DIR` mounted into the container) — apply it, create a room, and confirm from the room UI:
  - The "Sync subtitles" button appears once a subtitle is applied.
  - Clicking it shows "Syncing…", then after ~15-30s the subtitle in the video visibly re-aligns to match the actual dialogue timing.
  - "Undo" reverts to the pre-sync (deliberately-offset) timing.
  - A second "Undo" click (or a fresh sync after undo) doesn't error — matches the single-level-undo behavior.

- [ ] **Step 3: Verify the failure path leaves the live subtitle untouched**

Temporarily rename `/usr/local/bin/alass` inside a running container (`docker exec <container> mv /usr/local/bin/alass /usr/local/bin/alass.bak`), click "Sync subtitles" again, and confirm:
  - The UI shows a sync-failed error (not a silent hang or crash).
  - The subtitle file on disk (check via `docker exec <container> cat <path>.vtt`) is byte-identical to before the failed attempt — the backup-then-atomic-replace logic in `syncSubtitles` never partially wrote a broken file.

Restore the binary (`docker exec <container> mv /usr/local/bin/alass.bak /usr/local/bin/alass`) afterward.

- [ ] **Step 4: Clean up the test image and any scratch test data**

```bash
docker rmi pookieflix-sync-test
```

- [ ] **Step 5: Commit**

Only after Steps 2-3 both pass:

```bash
cd ~/Projects/Personal/watchtogether
git add Dockerfile server/src/subtitles.ts server/tests/subtitles.test.ts server/src/routes.ts client/src/pages/Room.tsx client/src/index.css
git commit -m "Add manual subtitle auto-sync via alass

One shared .vtt per video means syncing once fixes it for every
viewer/device. Single-level undo via a .presync.bak backup."
```

(No `Co-Authored-By` line, per standing instruction. Do not push — pushing to `main` triggers the GHCR auto-publish, which is a separate decision from committing locally.)
