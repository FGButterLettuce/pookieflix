# Lists v2 (redesign + history + autolink) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the "Marathons" feature (shipped 2026-08-03) into a polished "Lists" experience per an approved live-mockup iteration (https://claude.ai/code/artifact/a645eb1f-f7d6-48ee-b99d-d57ec40a3dc8), plus three tightly-related additions surfaced in the same design session: a library-first add flow, an upload-time autolink suggestion, and a Watch History view derived from orphaned HLS caches.

**Architecture:** Extends the existing `marathons`/`marathon_items`/`marathon_reviews` SQLite tables (adding `position` direct-set support, `poster_path`/`tmdb_id` columns) rather than renaming them — this is a UI-copy rename ("Marathons" → "Lists" in all user-facing text), not an internal identifier rename, to keep the change additive and low-risk. New: a `watch_history` table populated by scanning the library directory for orphaned `*.hls` caches (HLS exists, source `.mp4` deleted — the user's actual workflow is upload → watch → delete, so an orphaned HLS dir is an implicit "watched" signal already sitting on disk). New: a thin TMDB search proxy route for poster art on untracked titles, gated on an optional `TMDB_API_KEY` setting the user will populate after this ships ("build to their docs now, test tomorrow" — build the real integration, don't stub it, but fail gracefully with no key configured).

**Tech Stack:** Same as before — Fastify + `node:sqlite` (server), React 18 + Vite + TS + `react-router-dom` v6 (client), `node:test` (server tests). One new external integration (TMDB API, native `fetch`, no SDK dependency).

## Global Constraints

- No new npm dependencies, server or client (TMDB uses native `fetch`, drag-and-drop is native HTML5).
- "Marathons" → "Lists" is a UI-text-only rename. Internal identifiers stay: DB tables (`marathons`, `marathon_items`, `marathon_reviews`, new `watch_history`), route paths (`/api/marathons/...`), TS type names (`MarathonRow` etc.), CSS classes prefixed `marathon-`/`list-card` as already used. Do not rename these — only strings rendered in the UI change.
- Every route that touches user data stays behind the existing `requireAdmin` preHandler.
- `TMDB_API_KEY` and `LAN_URL` are new optional settings fields, following the exact existing pattern of `OPENSUBTITLES_API_KEY` in `persistedConfig.ts`/Settings.tsx — optional, feature gracefully disabled/hidden when unset, never a hard error surfaced to the user.
- No box/production deploy as part of this work unless explicitly requested later — build and verify locally (typecheck, build, server tests). Live/manual testing with a real TMDB key happens after this session, per explicit instruction.
- Every commit message is plain, no `Co-Authored-By` trailer.
- Design source of truth for all client visuals: the published mockup artifact. Match its component structure, spacing, and interaction patterns (banner-top cards, quoted chat-style reviews with score-colored rule, ring-avatar collapsed preview, spring-animated slider, native drag-and-drop via a handle icon only, library-first add flow) — these are approved, not open questions.

---

### Task 1: Schema additions — position reordering, TMDB fields, watch_history table

**Files:**
- Modify: `server/src/db.ts` (schema block in `getDb()`, new/changed functions)
- Modify: `server/src/types.ts` (new/changed types)
- Test: `server/tests/marathons-db.test.ts` (extend), `server/tests/watch-history-db.test.ts` (new)

**Interfaces:**
- Produces: `moveMarathonItemToPosition(marathonId: number, itemId: number, newPosition: number): void`, `updateMarathonItemPoster(itemId: number, posterPath: string | null, tmdbId: number | null): void`, `scanForOrphanedHlsEntries(): { hlsDirName: string; title: string; detectedAtMs: number }[]`, `recordWatchHistoryEntries(entries: { hlsDirName: string; title: string; detectedAtMs: number }[]): void`, `listWatchHistory(): WatchHistoryRow[]`, `dismissWatchHistoryEntry(id: number): void`
- Types: `WatchHistoryRow { id: number; hls_dir_name: string; title: string; detected_at: string; dismissed: number }`, extends `MarathonItemRow`/`MarathonItemDetail` with `posterPath: string | null` / `tmdbId: number | null` (camelCase in the detail type, snake_case `poster_path`/`tmdb_id` in the row type, matching the file's existing convention).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/marathons-db.test.ts`:

```ts
it('moves an item directly to an arbitrary position, renumbering the rest', () => {
  const m = db.createMarathon('Position Test');
  const a = db.addMarathonItem(m.id, 'A', null);
  const b = db.addMarathonItem(m.id, 'B', null);
  const c = db.addMarathonItem(m.id, 'C', null);
  db.moveMarathonItemToPosition(m.id, c.id, 0);
  const items = db.listMarathonItems(m.id);
  assert.deepEqual(items.map(i => i.title), ['C', 'A', 'B']);
});

it('moving to the same position is a no-op', () => {
  const m = db.createMarathon('Position NoOp Test');
  const a = db.addMarathonItem(m.id, 'A', null);
  db.addMarathonItem(m.id, 'B', null);
  db.moveMarathonItemToPosition(m.id, a.id, 0);
  const items = db.listMarathonItems(m.id);
  assert.deepEqual(items.map(i => i.title), ['A', 'B']);
});

it('sets and clears poster fields on an item', () => {
  const m = db.createMarathon('Poster Test');
  const item = db.addMarathonItem(m.id, 'A', null);
  db.updateMarathonItemPoster(item.id, '/abc123.jpg', 42);
  let items = db.listMarathonItems(m.id);
  assert.equal(items[0].posterPath, '/abc123.jpg');
  assert.equal(items[0].tmdbId, 42);
  db.updateMarathonItemPoster(item.id, null, null);
  items = db.listMarathonItems(m.id);
  assert.equal(items[0].posterPath, null);
  assert.equal(items[0].tmdbId, null);
});
```

Create `server/tests/watch-history-db.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('watch history', () => {
  let dataDir: string;
  let mediaDir: string;
  let db: typeof import('../src/db');

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-history-test-'));
    process.env.DATA_DIR = dataDir;
    db = await import('../src/db');
    const { config } = await import('../src/config');
    mediaDir = path.join(config.mediaDir, 'library');
    fs.mkdirSync(mediaDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('detects an orphaned .hls dir with no matching .mp4 as watched history', () => {
    fs.mkdirSync(path.join(mediaDir, 'The.Avengers.2012.hls'));
    fs.writeFileSync(path.join(mediaDir, 'Iron.Man.2008.mp4'), 'x');
    fs.mkdirSync(path.join(mediaDir, 'Iron.Man.2008.hls'));

    const found = db.scanForOrphanedHlsEntries();
    assert.deepEqual(found.map(f => f.title), ['The.Avengers.2012']);
  });

  it('records and lists watch history entries without duplicating on re-scan', () => {
    const found = db.scanForOrphanedHlsEntries();
    db.recordWatchHistoryEntries(found);
    db.recordWatchHistoryEntries(found); // re-scan should not duplicate
    const history = db.listWatchHistory();
    assert.equal(history.filter(h => h.title === 'The.Avengers.2012').length, 1);
  });

  it('dismissing an entry removes it from the active list', () => {
    const history = db.listWatchHistory();
    const entry = history.find(h => h.title === 'The.Avengers.2012')!;
    db.dismissWatchHistoryEntry(entry.id);
    const after = db.listWatchHistory();
    assert.ok(!after.some(h => h.id === entry.id));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test tests/marathons-db.test.ts tests/watch-history-db.test.ts`
Expected: FAIL — functions/table don't exist yet.

- [ ] **Step 3: Add schema and types**

In `server/src/types.ts`, add:

```ts
export interface WatchHistoryRow {
  id: number;
  hls_dir_name: string;
  title: string;
  detected_at: string;
  dismissed: number; // 0 | 1
}
```

Extend the existing `MarathonItemRow` and `MarathonItemDetail` interfaces (from Task 1 of the original plan) with:

```ts
  poster_path: string | null; // MarathonItemRow — snake_case, matches column
  tmdb_id: number | null;
```

```ts
  posterPath: string | null; // MarathonItemDetail — camelCase, matches API convention
  tmdbId: number | null;
```

In `server/src/db.ts`, extend the `getDb()` schema block (inside the same `CREATE TABLE IF NOT EXISTS ...` template string) with:

```sql
    CREATE TABLE IF NOT EXISTS watch_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      hls_dir_name  TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      detected_at   TEXT NOT NULL,
      dismissed     INTEGER NOT NULL DEFAULT 0
    );
```

Then, matching the existing `try { _db.exec('ALTER TABLE ...') } catch {}` migration idiom already used in this file for `library_meta.subtitle_name`, add two column migrations right after it:

```ts
  try { _db.exec('ALTER TABLE marathon_items ADD COLUMN poster_path TEXT DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE marathon_items ADD COLUMN tmdb_id INTEGER DEFAULT NULL'); } catch {}
```

- [ ] **Step 4: Add the data-access functions**

In `server/src/db.ts`:

```ts
export function moveMarathonItemToPosition(marathonId: number, itemId: number, newPosition: number): void {
  const db = getDb();
  const items = db.prepare(
    'SELECT id FROM marathon_items WHERE marathon_id = ? ORDER BY position ASC'
  ).all(marathonId) as unknown as { id: number }[];
  const fromIndex = items.findIndex(i => i.id === itemId);
  if (fromIndex === -1) return;
  const clamped = Math.max(0, Math.min(newPosition, items.length - 1));
  if (clamped === fromIndex) return;

  const [moved] = items.splice(fromIndex, 1);
  items.splice(clamped, 0, moved);

  db.exec('BEGIN');
  try {
    items.forEach((item, index) => {
      db.prepare('UPDATE marathon_items SET position = ? WHERE id = ?').run(index, item.id);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateMarathonItemPoster(itemId: number, posterPath: string | null, tmdbId: number | null): void {
  const db = getDb();
  db.prepare('UPDATE marathon_items SET poster_path = ?, tmdb_id = ? WHERE id = ?').run(posterPath, tmdbId, itemId);
}

// ── Watch history (derived from orphaned HLS caches) ───────────────────
export function scanForOrphanedHlsEntries(): { hlsDirName: string; title: string; detectedAtMs: number }[] {
  const libraryDir = path.join(config.mediaDir, 'library');
  if (!fs.existsSync(libraryDir)) return [];
  const entries = fs.readdirSync(libraryDir, { withFileTypes: true });
  const mp4Basenames = new Set(
    entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mp4'))
      .map(e => e.name.replace(/\.mp4$/i, ''))
  );
  return entries
    .filter(e => e.isDirectory() && e.name.toLowerCase().endsWith('.hls'))
    .map(e => ({ hlsDirName: e.name, title: e.name.replace(/\.hls$/i, '') }))
    .filter(({ title }) => !mp4Basenames.has(title))
    .map(({ hlsDirName, title }) => ({
      hlsDirName,
      title,
      detectedAtMs: fs.statSync(path.join(libraryDir, hlsDirName)).mtimeMs,
    }));
}

export function recordWatchHistoryEntries(entries: { hlsDirName: string; title: string; detectedAtMs: number }[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO watch_history (hls_dir_name, title, detected_at, dismissed)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(hls_dir_name) DO NOTHING
  `);
  for (const entry of entries) {
    stmt.run(entry.hlsDirName, entry.title, new Date(entry.detectedAtMs).toISOString());
  }
}

export function listWatchHistory(): WatchHistoryRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM watch_history WHERE dismissed = 0 ORDER BY detected_at DESC'
  ).all() as unknown as WatchHistoryRow[];
}

export function dismissWatchHistoryEntry(id: number): void {
  const db = getDb();
  db.prepare('UPDATE watch_history SET dismissed = 1 WHERE id = ?').run(id);
}
```

Add `import type { WatchHistoryRow } from './types';` alongside the existing type imports. Update `listMarathonItems()`'s mapping to also return `posterPath: item.poster_path, tmdbId: item.tmdb_id` in its returned objects, and update `addMarathonItem()`'s SQL/return value to include the two new nullable columns (default `NULL` on insert — the function signature itself doesn't need new parameters, poster fields are always set later via `updateMarathonItemPoster`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx tsx --test tests/marathons-db.test.ts tests/watch-history-db.test.ts`
Expected: PASS, all green.

- [ ] **Step 6: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/db.ts server/src/types.ts server/tests/marathons-db.test.ts server/tests/watch-history-db.test.ts
git commit -m "Add direct-position reorder, poster fields, and watch history schema"
```

---

### Task 2: Direct-position reorder route + watch history routes

**Files:**
- Modify: `server/src/routes.ts`
- Modify: `server/tests/marathons.routes.test.ts`
- Test: `server/tests/watch-history.routes.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `moveMarathonItemToPosition`, `scanForOrphanedHlsEntries`, `recordWatchHistoryEntries`, `listWatchHistory`, `dismissWatchHistoryEntry`.
- Produces: extends existing item PATCH to accept `{ position: number }`; `GET /api/history`, `POST /api/history/scan`, `DELETE /api/history/:id`, `POST /api/history/:id/promote` (creates or reuses a marathon by name and adds this history title as a new item, returning the created item — this is the "add to a list" action from history).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/marathons.routes.test.ts` (inside the existing `marathon items` describe block, alongside the other PATCH tests):

```ts
it('reorders via a direct position instead of move up/down', async () => {
  const addA = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Pos A' } });
  const addB = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Pos B' } });
  const addC = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Pos C' } });
  const itemC = (addC.json() as { item: { id: number } }).item;

  const res = await app.inject({
    method: 'PATCH', url: `/api/marathons/${marathonId}/items/${itemC.id}`, payload: { position: 0 },
  });
  assert.equal(res.statusCode, 200);

  const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
  const titles = (detail.json() as { items: { title: string }[] }).items.map(i => i.title);
  assert.deepEqual(titles.slice(0, 3), ['Pos C', 'Pos A', 'Pos B']);
});
```

Create `server/tests/watch-history.routes.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('watch history routes', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let mediaDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-history-routes-test-'));
    process.env.DATA_DIR = dataDir;
    const { config } = await import('../src/config');
    mediaDir = path.join(config.mediaDir, 'library');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(path.join(mediaDir, 'The.Terminal.2004.hls'));

    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('scans for orphaned entries and lists them', async () => {
    const scanRes = await app.inject({ method: 'POST', url: '/api/history/scan' });
    assert.equal(scanRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    assert.equal(listRes.statusCode, 200);
    const entries = (listRes.json() as { entries: { title: string }[] }).entries;
    assert.ok(entries.some(e => e.title === 'The.Terminal.2004'));
  });

  it('dismisses an entry', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entry = (listRes.json() as { entries: { id: number }[] }).entries[0];
    const delRes = await app.inject({ method: 'DELETE', url: `/api/history/${entry.id}` });
    assert.equal(delRes.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/history' });
    assert.ok(!(after.json() as { entries: { id: number }[] }).entries.some(e => e.id === entry.id));
  });

  it('promotes a history entry into a new list', async () => {
    await app.inject({ method: 'POST', url: '/api/history/scan' });
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entries = (listRes.json() as { entries: { id: number; title: string }[] }).entries;
    const entry = entries.find(e => e.title === 'The.Terminal.2004');
    if (!entry) throw new Error('expected re-scanned entry to still be present');

    const promoteRes = await app.inject({
      method: 'POST', url: `/api/history/${entry.id}/promote`, payload: { marathonName: 'Watched Archive' },
    });
    assert.equal(promoteRes.statusCode, 201);
    const body = promoteRes.json() as { item: { title: string }; marathonId: number };
    assert.equal(body.item.title, 'The.Terminal.2004');

    const marathonsRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    const marathons = (marathonsRes.json() as { marathons: { id: number; name: string }[] }).marathons;
    assert.ok(marathons.some(m => m.id === body.marathonId && m.name === 'Watched Archive'));
  });

  it('promoting into the same-named list again reuses it instead of duplicating', async () => {
    await app.inject({ method: 'POST', url: '/api/history/scan' });
    const before = await app.inject({ method: 'GET', url: '/api/marathons' });
    const beforeCount = (before.json() as { marathons: unknown[] }).marathons.filter(
      (m) => (m as { name: string }).name === 'Watched Archive'
    ).length;
    assert.equal(beforeCount, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts tests/watch-history.routes.test.ts`
Expected: FAIL — new route/behavior doesn't exist.

- [ ] **Step 3: Extend the item PATCH route and add history routes**

In `server/src/routes.ts`, find the existing item PATCH handler (from the original plan, the one handling `body.move`/`body.status`/`body.title`/`body.libraryFilename`). Add a `position` branch, checked before the `move` branch:

```ts
  if (typeof body.position === 'number') {
    moveMarathonItemToPosition(item.marathon_id, item.id, body.position);
    return reply.send({ ok: true });
  }
```

(Add `position?: number` to that handler's existing `req.body as {...}` cast, and add `moveMarathonItemToPosition` to the `import { ... } from './db';` line.)

Add a new section, after the marathon item review route:

```ts
// ── Watch history ──────────────────────────────────────────────────────
app.post('/api/history/scan', { preHandler: requireAdmin }, async (_req, reply) => {
  const found = scanForOrphanedHlsEntries();
  recordWatchHistoryEntries(found);
  return reply.send({ ok: true, found: found.length });
});

app.get('/api/history', { preHandler: requireAdmin }, async (_req, reply) => {
  const entries = listWatchHistory().map(e => ({
    id: e.id,
    title: e.title,
    detectedAt: e.detected_at,
  }));
  return reply.send({ entries });
});

app.delete('/api/history/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  dismissWatchHistoryEntry(Number(id));
  return reply.send({ ok: true });
});

app.post('/api/history/:id/promote', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { marathonName?: string };
  const name = body?.marathonName?.trim();
  if (!name) return reply.status(400).send({ error: 'marathonName is required' });

  const history = listWatchHistory();
  const entry = history.find(h => h.id === Number(id));
  if (!entry) return reply.status(404).send({ error: 'Not found' });

  const existing = listMarathons().find(m => m.name === name);
  const marathon = existing ? getMarathon(existing.id)! : createMarathon(name);
  const item = addMarathonItem(marathon.id, entry.title, null);
  updateMarathonItem(item.id, { status: 'done' });

  return reply.status(201).send({ marathonId: marathon.id, item });
});
```

Add `scanForOrphanedHlsEntries, recordWatchHistoryEntries, listWatchHistory, dismissWatchHistoryEntry` to the `import { ... } from './db';` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts tests/watch-history.routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.ts server/tests/marathons.routes.test.ts server/tests/watch-history.routes.test.ts
git commit -m "Add direct-position reorder and watch history routes"
```

---

### Task 3: TMDB search proxy + settings field

**Files:**
- Modify: `server/src/routes.ts` (settings shape, new route)
- Modify: `server/src/persistedConfig.ts` (if a typed settings interface lives there — check the file first; otherwise the settings object is likely untyped JSON, in which case just document the new key inline in the GET/PATCH `/api/settings` handlers)
- Modify: `client/src/pages/Settings.tsx` (new field, matching `OPENSUBTITLES_API_KEY`'s exact pattern)
- Test: `server/tests/tmdb.routes.test.ts` (new)

**Interfaces:**
- Produces: `GET /api/tmdb/search?query=...` → `{ results: { tmdbId: number; title: string; year: string | null; posterPath: string | null }[] }` when `TMDB_API_KEY` is configured; `503 { error: 'TMDB_API_KEY not configured' }` when it isn't.

- [ ] **Step 1: Look up the exact existing settings pattern first**

Before writing code, read how `OPENSUBTITLES_API_KEY` is threaded through today — grep `OPENSUBTITLES_API_KEY` across `server/src` and `client/src/pages/Settings.tsx` to find: where it's read from persisted config, how `GET /api/settings` exposes it, how `PATCH /api/settings` accepts it, and the exact JSX field markup in Settings.tsx. Mirror that pattern exactly for `TMDB_API_KEY` — same file(s), same shape, just a new key. Do not invent a different config-loading mechanism.

- [ ] **Step 2: Write the failing test**

Create `server/tests/tmdb.routes.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('tmdb search route', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-tmdb-test-'));
    process.env.DATA_DIR = dataDir;
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns 503 with no TMDB_API_KEY configured, rather than crashing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmdb/search?query=Thor' });
    assert.equal(res.statusCode, 503);
    assert.match((res.json() as { error: string }).error, /TMDB/);
  });

  it('rejects an empty query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmdb/search?query=' });
    assert.equal(res.statusCode, 400);
  });
});
```

(A live-key success-path test isn't written here — no real key is available yet. The 503-when-unconfigured path is the one that must be bulletproof, since that's the state this ships in today.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx tsx --test tests/tmdb.routes.test.ts`
Expected: FAIL — 404, route doesn't exist.

- [ ] **Step 4: Add the route**

Per TMDB's documented v3 API (`https://developer.themoviedb.org/reference/search-movie`): `GET https://api.themoviedb.org/3/search/movie?query=<q>&api_key=<key>` returns `{ results: [{ id, title, release_date, poster_path, ... }] }`. Poster images are served from `https://image.tmdb.org/t/p/<size>/<poster_path>` — use size `w342` for a reasonably sized thumbnail per TMDB's documented image size list.

In `server/src/routes.ts`, following whatever pattern Step 1 found for reading `OPENSUBTITLES_API_KEY` from persisted config (adjust the exact accessor to match what's actually there):

```ts
// ── TMDB search (optional — gated on TMDB_API_KEY) ─────────────────────
app.get('/api/tmdb/search', { preHandler: requireAdmin }, async (req, reply) => {
  const { query } = req.query as { query?: string };
  if (!query?.trim()) return reply.status(400).send({ error: 'query is required' });

  const apiKey = getPersistedConfig().TMDB_API_KEY; // match Step 1's real accessor
  if (!apiKey) return reply.status(503).send({ error: 'TMDB_API_KEY not configured' });

  try {
    const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}`;
    const tmdbRes = await fetch(url);
    if (!tmdbRes.ok) return reply.status(502).send({ error: 'TMDB request failed' });
    const data = await tmdbRes.json() as { results: { id: number; title: string; release_date?: string; poster_path: string | null }[] };
    const results = data.results.slice(0, 8).map(r => ({
      tmdbId: r.id,
      title: r.title,
      year: r.release_date ? r.release_date.slice(0, 4) : null,
      posterPath: r.poster_path,
    }));
    return reply.send({ results });
  } catch {
    return reply.status(502).send({ error: 'TMDB request failed' });
  }
});
```

Add `TMDB_API_KEY: ''` to wherever the default persisted-config shape is defined (matching `OPENSUBTITLES_API_KEY`'s default), and add it to whatever type/interface Step 1 found describing the settings shape.

- [ ] **Step 5: Add the Settings.tsx field**

Mirror the exact JSX block for `OPENSUBTITLES_API_KEY` in `client/src/pages/Settings.tsx` (found in Step 1), duplicating it for `TMDB_API_KEY` with appropriate label/placeholder text, e.g. label "TMDB API key", hint "Used to fetch poster art for movies not in your library. Get a free key at themoviedb.org — optional, poster art is skipped without one."

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && npx tsx --test tests/tmdb.routes.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck both sides**

Run: `cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes.ts client/src/pages/Settings.tsx
git commit -m "Add TMDB search route and API key setting"
```

(If Step 1 found the settings type/default lives in another file, e.g. `persistedConfig.ts`, include it in the `git add`.)

---

### Task 4: Autolink match route

**Files:**
- Modify: `server/src/routes.ts`
- Test: `server/tests/autolink.routes.test.ts` (new)

**Interfaces:**
- Produces: `GET /api/marathons/match?filename=<uploaded filename>` → `{ match: { marathonId: number; marathonName: string; itemId: number; itemTitle: string } | null }`.
- Matching heuristic lives in a plain exported function so it's unit-testable in isolation from the route.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/autolink.routes.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('autolink matching', () => {
  let matchFilenameToUntrackedItem: typeof import('../src/routes').matchFilenameToUntrackedItem;

  before(async () => {
    ({ matchFilenameToUntrackedItem } = await import('../src/routes'));
  });

  it('normalizes junk tokens and matches on the cleaned title', () => {
    const cleaned = matchFilenameToUntrackedItem('Thor.2011.1080p.BluRay.x264.YIFY_transcode.mp4', ['Thor', 'Iron Man']);
    assert.equal(cleaned, 'Thor');
  });

  it('does not match when nothing corresponds', () => {
    const cleaned = matchFilenameToUntrackedItem('Some.Random.Movie.2020.mp4', ['Thor', 'Iron Man']);
    assert.equal(cleaned, null);
  });

  it('is case-insensitive and tolerant of spacing/punctuation differences', () => {
    const cleaned = matchFilenameToUntrackedItem('captain_america_the_winter_soldier_2014.mkv', ['Captain America: The Winter Soldier']);
    assert.equal(cleaned, 'Captain America: The Winter Soldier');
  });
});

describe('autolink match route', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-autolink-test-'));
    process.env.DATA_DIR = dataDir;
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('finds an untracked item across lists matching an uploaded filename', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'MCU Rewatch' } });
    const marathon = (marathonRes.json() as { marathon: { id: number } }).marathon;
    await app.inject({ method: 'POST', url: `/api/marathons/${marathon.id}/items`, payload: { title: 'Thor' } });

    const res = await app.inject({ method: 'GET', url: '/api/marathons/match?filename=Thor.2011.1080p.BluRay.mp4' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { match: { marathonName: string; itemTitle: string } | null };
    assert.equal(body.match?.marathonName, 'MCU Rewatch');
    assert.equal(body.match?.itemTitle, 'Thor');
  });

  it('does not match an item that already has a library file linked', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Already Linked' } });
    const marathon = (marathonRes.json() as { marathon: { id: number } }).marathon;
    const itemRes = await app.inject({ method: 'POST', url: `/api/marathons/${marathon.id}/items`, payload: { title: 'Iron Man' } });
    const item = (itemRes.json() as { item: { id: number } }).item;
    await app.inject({ method: 'PATCH', url: `/api/marathons/${marathon.id}/items/${item.id}`, payload: { title: 'Iron Man' } });
    // deliberately not linking a real library filename here (assertLibraryPath would reject a fake one in this test env) —
    // instead this test documents the requirement at the SQL level: listUntrackedTitles must filter library_filename IS NULL.

    const res = await app.inject({ method: 'GET', url: '/api/marathons/match?filename=Nonexistent.Movie.mp4' });
    assert.equal((res.json() as { match: unknown }).match, null);
  });

  it('rejects a missing filename param', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/marathons/match' });
    assert.equal(res.statusCode, 400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test tests/autolink.routes.test.ts`
Expected: FAIL — export/route don't exist.

- [ ] **Step 3: Add the matching function and route**

In `server/src/db.ts`, add a function to fetch candidate untracked titles across all lists:

```ts
export function listUntrackedItemTitles(): { marathonId: number; marathonName: string; itemId: number; itemTitle: string }[] {
  const db = getDb();
  return db.prepare(`
    SELECT m.id AS marathonId, m.name AS marathonName, mi.id AS itemId, mi.title AS itemTitle
    FROM marathon_items mi
    JOIN marathons m ON m.id = mi.marathon_id
    WHERE mi.library_filename IS NULL
  `).all() as unknown as { marathonId: number; marathonName: string; itemId: number; itemTitle: string }[];
}
```

In `server/src/routes.ts`, add the pure matching function (exported for the unit tests in Step 1) and the route:

```ts
// Strips common release-group/quality/codec junk tokens and normalizes
// punctuation/case, then checks whether any candidate title appears in the
// cleaned filename (or vice versa, for a short candidate title against a
// longer cleaned name). Deliberately simple substring matching, not a
// fuzzy/edit-distance library — good enough for "does this upload look like
// a title I already typed", and a false negative just means no suggestion
// banner rather than a wrong link, so erring conservative is fine.
const JUNK_TOKENS = /\b(1080p|720p|2160p|4k|bluray|blu-ray|webrip|web-dl|hdrip|dvdrip|x264|x265|h264|h265|hevc|yify|yts|transcode|extended|remastered|directors?[._-]?cut)\b/gi;

function cleanTitleToken(raw: string): string {
  return raw
    .replace(/\.[a-z0-9]+$/i, '') // drop file extension
    .replace(/[._]/g, ' ')
    .replace(JUNK_TOKENS, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ') // drop a bare 4-digit year
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchFilenameToUntrackedItem(filename: string, candidateTitles: string[]): string | null {
  const cleanedFilename = cleanTitleToken(filename);
  if (!cleanedFilename) return null;
  for (const title of candidateTitles) {
    const cleanedTitle = cleanTitleToken(title);
    if (!cleanedTitle) continue;
    if (cleanedFilename.includes(cleanedTitle) || cleanedTitle.includes(cleanedFilename)) {
      return title;
    }
  }
  return null;
}

// ── Autolink match ──────────────────────────────────────────────────────
app.get('/api/marathons/match', { preHandler: requireAdmin }, async (req, reply) => {
  const { filename } = req.query as { filename?: string };
  if (!filename?.trim()) return reply.status(400).send({ error: 'filename is required' });

  const candidates = listUntrackedItemTitles();
  const matchedTitle = matchFilenameToUntrackedItem(filename, candidates.map(c => c.itemTitle));
  if (!matchedTitle) return reply.send({ match: null });

  const match = candidates.find(c => c.itemTitle === matchedTitle)!;
  return reply.send({ match });
});
```

Add `listUntrackedItemTitles` to the `import { ... } from './db';` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test tests/autolink.routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.ts server/src/db.ts server/tests/autolink.routes.test.ts
git commit -m "Add autolink filename-matching heuristic and match route"
```

---

### Task 5: Full server test suite sanity pass

**Files:** none (verification-only task)

- [ ] **Step 1: Run everything**

Run: `cd server && npx tsx --test tests/*.test.ts`
Expected: baseline 69 + all new tests from Tasks 1-4 passing; only the 4 pre-existing, confirmed-unrelated `roomStateMachine.test.ts` failures remain.

- [ ] **Step 2: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit (only if Step 1 required any fixes)**

If everything already passed, skip this task's commit — it's a checkpoint, not a code change.

---

### Task 6: Shared client components — ListCard and viewer library extraction

**Files:**
- Create: `client/src/components/ListCard.tsx`
- Modify: `client/src/lib/viewer.ts` (no functional change expected — read it first to confirm the existing `Viewer` type/exports are unchanged and reusable)

**Interfaces:**
- Produces: `ListCard({ id, name, itemCount, doneCount }: { id: number; name: string; itemCount: number; doneCount: number }): JSX.Element` — the card used both on the Home rail and the full Lists page, so the two never drift visually.

- [ ] **Step 1: Create the component**

```tsx
import { Link } from 'react-router-dom';

export interface ListCardProps {
  id: number;
  name: string;
  itemCount: number;
  doneCount: number;
}

export function ListCard({ id, name, itemCount, doneCount }: ListCardProps) {
  const pct = itemCount > 0 ? Math.round((doneCount / itemCount) * 100) : 0;
  return (
    <Link to={`/marathons/${id}`} className="list-card">
      <div className="list-card-name">{name}</div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <div className="list-card-progress">{doneCount}/{itemCount} done</div>
    </Link>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no errors (component isn't used anywhere yet, but must compile standalone).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ListCard.tsx
git commit -m "Extract shared ListCard component"
```

---

### Task 7: Lists page rebuild (rename, banner-cap width, real card component)

**Files:**
- Modify: `client/src/pages/Marathons.tsx`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `ListCard` (Task 6), existing `GET/POST /api/marathons`.

- [ ] **Step 1: Rewrite the page**

Replace the body of `client/src/pages/Marathons.tsx` (keep the existing auth-gating `authed` state pattern and `createMarathon` POST logic exactly as-is) with:
- All visible text "Marathons" → "Lists", "New marathon name" → "New list name" placeholder, heading "Lists".
- Card grid rendering swapped to use `<ListCard key={m.id} {...m} />` instead of the inline `<Link className="list-card">` markup, importing `ListCard` from `../components/ListCard`.
- Empty state copy: "No lists yet — create one above."

- [ ] **Step 2: CSS — cap content width, matching the mockup and Settings' own precedent**

In `client/src/index.css`, wrap the existing `.marathons-heading`/`.marathon-new-form`/`.marathon-card-grid` etc. rules are already token-driven from the original implementation — add a single new rule capping the page body width, matching `.settings-page`'s existing `max-width: 640px; margin: 0 auto;` pattern exactly:

```css
.marathons-page-body {
  max-width: 640px;
  margin: 0 auto;
  width: 100%;
}
```

In `Marathons.tsx`, wrap the content below the topbar (the form + grid) in `<div className="marathons-page-body">...</div>`.

- [ ] **Step 3: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Marathons.tsx client/src/index.css
git commit -m "Rebuild Lists page: rename copy, capped width, shared card component"
```

---

### Task 8: Marathon detail page — banner cards, quoted reviews, ring-avatar preview, click-to-rename

**Files:**
- Modify: `client/src/pages/MarathonDetail.tsx`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: existing item/review routes, Task 1-2's `position`-based reorder (replaces `move` up/down calls), Task 1's `posterPath`/`tmdbId` fields on items (rendered as poster fallback — TMDB search wiring itself is Task 10).
- Produces: click-to-rename for both the list name (topbar title) and each item's title, via `PATCH /api/marathons/:id` `{name}` and `PATCH .../items/:itemId` `{title}` (both routes already exist).

This is the largest task in the plan — it is a full visual rebuild of the page matching the mockup exactly. Implement in this order, verifying compile after each:

- [ ] **Step 1: Item card shell — banner-top layout**

Replace each item's markup with: a full-width thumbnail banner (`aspect-ratio: 2.4/1` for library-linked items showing an actual `<img>` if the app exposes a thumbnail URL for library files — check `LibraryFileInfo`'s `thumbUrl` field, already fetched via the existing `GET /api/library` call in this component, and use it keyed by `item.libraryFilename`; a plain icon-plate placeholder for unlinked items, using `item.posterPath` as an `<img src={\`https://image.tmdb.org/t/p/w342${item.posterPath}\`}>` when present instead of the plate), then a body section below containing title/status/reviews, exactly matching the mockup's `.item-thumb` / `.item-body` structure. Port the mockup's CSS classes (`.item-card`, `.item-thumb`, `.item-body`, `.item-row`, `.item-title`, `.status-group`, `.btn-done`, `.status-badge`) into `client/src/index.css`, adapted from the mockup file's literal CSS (same property values — this is a direct port, not a redesign-of-the-redesign).

Run `cd client && npx tsc --noEmit` after this step and each subsequent one.

- [ ] **Step 2: Click-to-rename — list title and item titles**

Topbar title: replace the static `<h1>{name}</h1>` with a click-to-edit control — on click, swap to a text `<input>` pre-filled with the current name, auto-focused; on blur or Enter, `PATCH /api/marathons/:id` with `{ name: trimmedValue }` if changed, then reload; Escape cancels without saving. Same pattern for each item's title (swap `<div className="item-title">` for an editable version using `PATCH .../items/:itemId` `{ title }`). Reuse one small local component or hook for this since the interaction is identical in both places — name it `EditableText` (`client/src/components/EditableText.tsx`), props `{ value: string; onSave: (next: string) => void; className?: string }`, internal `editing` boolean state.

- [ ] **Step 3: Collapsible reviews — quote styling, score-colored rule, ring-avatar preview**

Port the mockup's `.reviews-toggle`, `.ring-avatars`/`.ring-avatar`, `.reviews-panel`, `.reviews-thread`, `.review-msg`/`.review-avatar`/`.review-bubble`, `.review-score-num`, `.review-note-text` (with the `::before`/`::after` curly-quote content and `--rule-color` custom property) CSS verbatim from the mockup file into `index.css`. In the component: a `expandedItemIds: Set<number>` piece of state (or per-item local state) toggles each item's panel; the toggle button shows `Reviews (N)` plus ring-avatar previews (`--ring` inline style set to `color-mix(in oklch, var(--success) X%, var(--danger))` computed from each review's score, same formula as the mockup's `scoreColorMix`); the panel, when open, renders each review as a `<blockquote className="review-note-text">` with `--rule-color` set the same way.

- [ ] **Step 4: Score slider — spring-animated readout**

Port the mockup's `.score-slider`, `.score-slider-value`, `.score-slider-wrap` CSS and the `scoreColorMix`/spring-follow `requestAnimationFrame` loop JS logic into the component as a small internal hook, e.g. `useSpringValue(target: number): number` implemented with a `useRef` for the raf id and displayed value, `useEffect` driving the loop exactly as the mockup's `tick()`/`paintReadout()` functions did (same lerp factor `0.14`, same settle threshold `0.02`, same "don't round to the 0.5 grid until settled" fix). Wire the range `<input type="range" min="1" max="10" step="0.5">`'s `onChange` to update both the target value state and the existing `saveReview` PATCH call's payload.

- [ ] **Step 5: Drag-and-drop reordering**

Port the mockup's native-HTML5 drag-and-drop exactly: `draggable="true"` on a dedicated grip-icon handle (not the card), `dragstart`/`dragend` on the handle, `dragover`/`dragleave`/`drop` on the card. On `drop`, instead of the mockup's pure-DOM reorder, call `PATCH .../items/:itemId` with `{ position: <the dropped-on item's index> }` (Task 2's new capability), then reload the list from the server (don't locally reorder DOM state and trust it — let the server's returned order be the source of truth, avoiding drift if the PATCH fails). Remove the old `move()`/`ArrowUp`/`ArrowDown` button code entirely — it's fully superseded.

- [ ] **Step 6: Library-first "Add from your library" flow**

Replace the existing text-input + native `<select>` add-item form with: a search `<input>` filtering the already-fetched `libraryFiles` list client-side (simple case-insensitive substring match against filename, no new endpoint needed), rendered as a horizontally-scrollable strip of thumbnail tiles (`.library-strip`/`.library-tile`/`.library-tile-thumb`/`.add-badge`/`.already-added-badge` CSS ported from the mockup, including the padding fix that resolved the clipping bug found in the mockup review). Tapping a tile calls `POST .../items` with `{ title: <filename minus extension>, libraryFilename: <filename> }` directly (no intermediate form step). Items whose `libraryFilename` is already present in this list's current items get the "In list" badge treatment and reduced opacity, non-clickable.

Below the strip, a demoted "+ Track a movie you don't have" link reveals the old manual title-only input (kept as the fallback path, not removed) — when that fallback is used, after creating the item, immediately offer the TMDB poster search step (this wiring is completed in Task 10 once the search route exists; for this task, add the item without a poster and leave a visible "Add poster" affordance on it, matching how items already support an editable poster field once Task 10 lands).

- [ ] **Step 7: Icon-button chrome fix (resolves the parked finding from the original implementation)**

In `client/src/index.css`, fix `.settings-link` to work correctly on `<button>` elements, not just `<a>` — this was flagged during the original implementation's final review, verified real (native browser button chrome bleeding through), and parked as non-blocking at the time. Fix it now:

```css
.settings-link {
  /* existing rules unchanged */
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
}
```

(Add the three new lines to the existing rule — do not duplicate the selector.) This fixes every icon-only button using this class across the whole app (Room's back button, Settings' back button, Home's icon buttons, and all the new Lists/Home buttons this plan adds), not just the ones added here.

- [ ] **Step 8: Final typecheck and build for this task**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/MarathonDetail.tsx client/src/components/EditableText.tsx client/src/index.css
git commit -m "Rebuild list detail page: banner cards, quoted reviews, spring slider, drag reorder, library-first add"
```

---

### Task 9: Home screen — Lists rail, Continue Watching/library polish, autolink banner, LAN upload button

**Files:**
- Modify: `client/src/pages/Home.tsx`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `GET /api/marathons` (existing), `ListCard` (Task 6), `GET /api/marathons/match` (Task 4), `LAN_URL` setting (added in this task, following the exact `TMDB_API_KEY`/`OPENSUBTITLES_API_KEY` pattern from Task 3's Step 1 findings).

- [ ] **Step 1: Add the LAN_URL setting**

Mirror Task 3 Step 1's findings again: add `LAN_URL: ''` to the same default-config/type location as `TMDB_API_KEY`, and a matching field in `Settings.tsx` — label "LAN address", hint "Your PookieFlix box's local network address (e.g. http://192.168.0.91:3000) — used for the Upload shortcut, since large video uploads are unreliable over the public tunnel."

- [ ] **Step 2: Lists rail on Home**

Fetch `GET /api/marathons` in `Home.tsx` (new `useEffect`, same fetch-on-mount + `authed`-gated pattern already used for the library fetch), render a `.home-section` with a `.home-section-header` ("Your lists", count) plus a "See all →" link to `/marathons`, and a `.home-rail` horizontal strip of `<ListCard>` components (reusing the same component from the Lists page — Task 6's whole point). Port `.home-section`/`.home-section-header`/`.home-rail` CSS from the mockup.

- [ ] **Step 3: Autolink suggestion banner**

After the existing upload-success handling in `Home.tsx` (find wherever the upload flow currently signals completion — likely inside the existing dropzone's success callback), call `GET /api/marathons/match?filename=<uploaded filename>`. If `match` is non-null, show a dismissible banner (port `.autolink-toast` CSS from the mockup) reading `"<filename>" looks like a match` / `Link it to "<itemTitle>" in <marathonName>?` with a "Link it" button that calls `PATCH /api/marathons/:marathonId/items/:itemId` with `{ libraryFilename: <uploaded filename> }`, and a "Dismiss" link that just hides the banner. Store the banner's data in a small piece of local state (`autolinkSuggestion: { marathonId, marathonName, itemId, itemTitle, filename } | null`), cleared on dismiss or after a successful link.

- [ ] **Step 4: LAN upload button in the topbar**

Add an icon button to Home's topbar (only rendered when `LAN_URL` is non-empty in the fetched settings) that opens `LAN_URL` in a new tab (`window.open(LAN_URL, '_blank', 'noopener,noreferrer')`), positioned per the mockup (before the Lists icon). Keep the existing inline upload dropzone exactly as-is — this is additive, not a replacement.

- [ ] **Step 5: Continue Watching / library grid visual polish**

Port the mockup's `.continue-card`/`.continue-thumb`/`.continue-body`/`.continue-title`/`.continue-meta`/`.meta-pill`/`.btn-resume` CSS into `index.css`, applying the class renames to Home's existing Continue Watching JSX (the underlying data/logic is unchanged — this is a CSS/markup pass, not new functionality). Same for `.library-grid`/`.library-card` on the "Your library" grid below it.

- [ ] **Step 6: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Home.tsx client/src/pages/Settings.tsx client/src/index.css
git commit -m "Add Lists rail, autolink suggestion, LAN upload button, and visual polish to Home"
```

---

### Task 10: Watch History page + TMDB poster picker wiring

**Files:**
- Create: `client/src/pages/WatchHistory.tsx`
- Modify: `client/src/App.tsx` (register `/history` route)
- Modify: `client/src/pages/Home.tsx` (nav entry to History)
- Modify: `client/src/pages/MarathonDetail.tsx` (wire the TMDB poster-search step left as a placeholder in Task 8 Step 6)
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: Task 2's `GET/DELETE /api/history`, `POST /api/history/:id/promote`; Task 3's `GET /api/tmdb/search`.

- [ ] **Step 1: Watch History page**

Create a page following the exact structure of `Marathons.tsx` (topbar with back arrow, auth-gated fetch): on mount, `POST /api/history/scan` (idempotent — re-scanning just finds nothing new after the first run) then `GET /api/history`, render each entry as a simple card (title + detected date), with two actions per entry: "Add to a list" (opens a small inline text input for the list name, defaulting to something reasonable like "Watched", calling `POST /api/history/:id/promote`) and a dismiss icon button (`DELETE /api/history/:id`). Empty state: "Nothing here yet — this fills in automatically from movies you've watched and removed from your library."

- [ ] **Step 2: Register the route and nav entry**

`App.tsx`: add `<Route path="/history" element={<WatchHistory />} />` above the catch-all. `Home.tsx`: add a topbar icon button linking to `/history` (a simple clock/history icon), following the exact `<Link className="settings-link">` pattern already used for the other topbar nav icons.

- [ ] **Step 3: Wire TMDB poster search into the add-item fallback flow**

In `MarathonDetail.tsx`'s manual "track a movie you don't have" fallback (Task 8 Step 6 left this without poster wiring): after the item is created, call `GET /api/tmdb/search?query=<title>`. If the response is `503` (no key configured), silently skip — no error shown, no poster step, matching "gracefully hidden when unconfigured." If results come back, show a small strip of poster candidates (image `src` = `https://image.tmdb.org/t/p/w185${posterPath}`) the user can tap to select, or a "Skip" option; selecting one calls a new small PATCH — reuse the existing item PATCH route, extended to accept optional `posterPath`/`tmdbId` fields (add this acceptance to the same handler touched in Task 2 Step 3, using Task 1's `updateMarathonItemPoster`).

- [ ] **Step 4: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/WatchHistory.tsx client/src/App.tsx client/src/pages/Home.tsx client/src/pages/MarathonDetail.tsx server/src/routes.ts client/src/index.css
git commit -m "Add Watch History page and wire TMDB poster picker into manual item add"
```

---

### Task 11: Full-branch verification pass

**Files:** none (verification-only)

- [ ] **Step 1: Full server suite**

Run: `cd server && npx tsx --test tests/*.test.ts`
Expected: only the 4 known-unrelated `roomStateMachine.test.ts` failures; everything else green, including every test added across Tasks 1-4.

- [ ] **Step 2: Full client typecheck + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: clean, no errors, no new bundle-size regressions beyond the existing pre-flagged chunk-size warning.

- [ ] **Step 3: Confirm no stray uncommitted files**

Run: `git status --short` from the worktree root.
Expected: clean (everything from Tasks 1-10 committed). If anything unexpected is present, investigate before considering the plan complete — do not silently leave uncommitted work.
