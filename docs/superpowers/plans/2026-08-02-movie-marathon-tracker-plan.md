# Movie Marathon Tracker + Who's-Watching Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external Google Keep marathon checklist with an in-app "Marathons" feature (named ordered movie lists, per-item pending/done/skipped status, independent 1-10 score + note per viewer), fronted by a lightweight Netflix-style "who's watching" profile-select screen.

**Architecture:** Three new SQLite tables (`marathons`, `marathon_items`, `marathon_reviews`) added to the existing `node:sqlite` schema in `server/src/db.ts`, exposed via new REST routes in `server/src/routes.ts` behind the existing `requireAdmin` household-password guard. Viewer identity ("who's watching") is a client-only concept — no new accounts, no new server session type — just a `'user' | 'partner'` string stored in `localStorage` and sent along with review writes, reusing the two display names (`USER_NAME`/`PARTNER_NAME`) that already exist in Settings.

**Tech Stack:** Fastify + `node:sqlite` (server), React 18 + Vite + TS + `react-router-dom` v6 (client), `node:test` + `node:assert/strict` for server tests. No new npm dependencies.

## Global Constraints

- No new npm dependencies (server or client) — no TMDB/poster integration, no drag-and-drop library, no `@radix-ui/react-alert-dialog`. Destructive actions use the browser's native `window.confirm()`, matching the smallest change that adds a safety net without a new dependency (the existing codebase has no confirm-dialog precedent at all — `Home.tsx`'s file delete has none).
- No migrations framework — new tables are added to the existing single `CREATE TABLE IF NOT EXISTS ...` block in `getDb()`, matching current convention exactly.
- The household password (`wt_session` cookie, `requireAdmin` preHandler) is unchanged and still the only real access-control boundary. The who's-watching screen is an attribution label, not an auth boundary.
- Viewer identity is exactly two stable string literals, `'user'` and `'partner'` — not the raw names from Settings (names are display-only and can change without breaking stored reviews).
- No migration of the old Google Keep list, no auto-detection of "watched" from playback history (per the approved spec, `docs/superpowers/specs/2026-08-02-movie-marathon-tracker-design.md`).
- No box/production deployment as part of this work — build and test locally only.
- Every commit message is plain, no `Co-Authored-By` trailer.

---

### Task 1: Marathon schema, types, and DB data-access functions

**Files:**
- Modify: `server/src/db.ts` (add tables to `getDb()`, add new exported functions)
- Modify: `server/src/types.ts` (add row + API response types)
- Test: `server/tests/marathons-db.test.ts` (new file)

**Interfaces:**
- Produces (used by Task 2-4's routes):
  - `createMarathon(name: string): MarathonRow`
  - `listMarathons(): MarathonSummary[]`
  - `getMarathon(id: number): MarathonRow | undefined`
  - `renameMarathon(id: number, name: string): void`
  - `deleteMarathon(id: number): void`
  - `listMarathonItems(marathonId: number): MarathonItemDetail[]`
  - `addMarathonItem(marathonId: number, title: string, libraryFilename: string | null): MarathonItemRow`
  - `getMarathonItem(id: number): MarathonItemRow | undefined`
  - `updateMarathonItem(id: number, fields: { title?: string; libraryFilename?: string | null; status?: 'pending' | 'done' | 'skipped' }): void`
  - `deleteMarathonItem(id: number): void`
  - `moveMarathonItem(marathonId: number, itemId: number, direction: 'up' | 'down'): void`
  - `upsertMarathonReview(itemId: number, viewer: 'user' | 'partner', score: number | null, note: string | null): void`
  - Types: `MarathonRow`, `MarathonItemRow`, `MarathonReviewRow`, `MarathonSummary`, `MarathonItemDetail`

- [ ] **Step 1: Write the failing test**

Create `server/tests/marathons-db.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('marathon data access', () => {
  let dataDir: string;
  let db: typeof import('../src/db');

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathon-db-test-'));
    process.env.DATA_DIR = dataDir;
    db = await import('../src/db');
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a marathon with position 0', () => {
    const m = db.createMarathon('Avengers Marathon');
    assert.equal(m.name, 'Avengers Marathon');
    assert.equal(m.position, 0);
  });

  it('lists marathons with item/done counts', () => {
    const m = db.createMarathon('Test Marathon');
    const item = db.addMarathonItem(m.id, 'Iron Man', null);
    db.updateMarathonItem(item.id, { status: 'done' });
    const list = db.listMarathons();
    const found = list.find(x => x.id === m.id)!;
    assert.equal(found.itemCount, 1);
    assert.equal(found.doneCount, 1);
  });

  it('orders items by position and supports moving them', () => {
    const m = db.createMarathon('Order Test');
    const a = db.addMarathonItem(m.id, 'A', null);
    const b = db.addMarathonItem(m.id, 'B', null);
    db.moveMarathonItem(m.id, b.id, 'up');
    const items = db.listMarathonItems(m.id);
    assert.deepEqual(items.map(i => i.title), ['B', 'A']);
    void a;
  });

  it('upserts a review independently per viewer', () => {
    const m = db.createMarathon('Review Test');
    const item = db.addMarathonItem(m.id, 'Thor', null);
    db.upsertMarathonReview(item.id, 'user', 9, 'great');
    db.upsertMarathonReview(item.id, 'partner', 6, null);
    db.upsertMarathonReview(item.id, 'user', 10, 'even better');
    const items = db.listMarathonItems(m.id);
    const reviews = items[0].reviews;
    assert.equal(reviews.length, 2);
    assert.deepEqual(reviews.find(r => r.viewer === 'user'), { viewer: 'user', score: 10, note: 'even better' });
    assert.deepEqual(reviews.find(r => r.viewer === 'partner'), { viewer: 'partner', score: 6, note: null });
  });

  it('deleting a marathon cascades to its items and reviews', () => {
    const m = db.createMarathon('Cascade Test');
    const item = db.addMarathonItem(m.id, 'Doomed', null);
    db.upsertMarathonReview(item.id, 'user', 5, null);
    db.deleteMarathon(m.id);
    assert.equal(db.getMarathon(m.id), undefined);
    assert.equal(db.getMarathonItem(item.id), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx tsx --test tests/marathons-db.test.ts`
Expected: FAIL — `db.createMarathon is not a function` (the functions don't exist yet).

- [ ] **Step 3: Add types**

In `server/src/types.ts`, add (near the existing `RoomRow`/`LibraryMetaRow` definitions):

```ts
export interface MarathonRow {
  id: number;
  name: string;
  position: number;
  created_at: string;
}

export interface MarathonItemRow {
  id: number;
  marathon_id: number;
  position: number;
  title: string;
  library_filename: string | null;
  status: 'pending' | 'done' | 'skipped';
  created_at: string;
}

export interface MarathonReviewRow {
  item_id: number;
  viewer: 'user' | 'partner';
  score: number | null;
  note: string | null;
  updated_at: string;
}

export interface MarathonSummary {
  id: number;
  name: string;
  position: number;
  itemCount: number;
  doneCount: number;
}

export interface MarathonItemDetail {
  id: number;
  position: number;
  title: string;
  libraryFilename: string | null;
  status: 'pending' | 'done' | 'skipped';
  reviews: { viewer: 'user' | 'partner'; score: number | null; note: string | null }[];
}
```

- [ ] **Step 4: Add the schema and data-access functions to `server/src/db.ts`**

Inside `getDb()`, extend the existing `_db.exec(\`...\`)` template string (the one that currently creates `rooms` and `library_meta`) by adding these three tables and two indexes before the closing backtick — no `REFERENCES ... ON DELETE CASCADE` clause, matching the fact that no table in this schema uses foreign keys; cascading deletes are handled explicitly in application code below, the same way `renameLibraryFile` already does manual multi-statement transactions:

```sql
    CREATE TABLE IF NOT EXISTS marathons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marathon_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      marathon_id       INTEGER NOT NULL,
      position          INTEGER NOT NULL,
      title             TEXT NOT NULL,
      library_filename  TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marathon_reviews (
      item_id    INTEGER NOT NULL,
      viewer     TEXT NOT NULL,
      score      INTEGER,
      note       TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_id, viewer)
    );

    CREATE INDEX IF NOT EXISTS idx_marathon_items_marathon ON marathon_items(marathon_id);
    CREATE INDEX IF NOT EXISTS idx_marathon_reviews_item ON marathon_reviews(item_id);
```

Then, at the bottom of `server/src/db.ts`, add the new exported functions:

```ts
import type { MarathonRow, MarathonItemRow, MarathonSummary, MarathonItemDetail } from './types';

export function createMarathon(name: string): MarathonRow {
  const db = getDb();
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM marathons').get() as { next: number }).next;
  const created_at = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO marathons (name, position, created_at) VALUES (?, ?, ?)'
  ).run(name, position, created_at);
  return { id: Number(result.lastInsertRowid), name, position, created_at };
}

export function listMarathons(): MarathonSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      m.id, m.name, m.position,
      COUNT(mi.id) AS itemCount,
      SUM(CASE WHEN mi.status = 'done' THEN 1 ELSE 0 END) AS doneCount
    FROM marathons m
    LEFT JOIN marathon_items mi ON mi.marathon_id = m.id
    GROUP BY m.id
    ORDER BY m.position ASC
  `).all() as unknown as { id: number; name: string; position: number; itemCount: number; doneCount: number | null }[];
  return rows.map(r => ({ id: r.id, name: r.name, position: r.position, itemCount: r.itemCount, doneCount: r.doneCount ?? 0 }));
}

export function getMarathon(id: number): MarathonRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM marathons WHERE id = ?').get(id) as unknown as MarathonRow | undefined;
}

export function renameMarathon(id: number, name: string): void {
  const db = getDb();
  db.prepare('UPDATE marathons SET name = ? WHERE id = ?').run(name, id);
}

export function deleteMarathon(id: number): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM marathon_reviews WHERE item_id IN (SELECT id FROM marathon_items WHERE marathon_id = ?)').run(id);
    db.prepare('DELETE FROM marathon_items WHERE marathon_id = ?').run(id);
    db.prepare('DELETE FROM marathons WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listMarathonItems(marathonId: number): MarathonItemDetail[] {
  const db = getDb();
  const items = db.prepare(
    'SELECT * FROM marathon_items WHERE marathon_id = ? ORDER BY position ASC'
  ).all(marathonId) as unknown as MarathonItemRow[];
  const reviews = db.prepare(
    'SELECT * FROM marathon_reviews WHERE item_id IN (SELECT id FROM marathon_items WHERE marathon_id = ?)'
  ).all(marathonId) as unknown as { item_id: number; viewer: string; score: number | null; note: string | null }[];
  return items.map(item => ({
    id: item.id,
    position: item.position,
    title: item.title,
    libraryFilename: item.library_filename,
    status: item.status,
    reviews: reviews
      .filter(r => r.item_id === item.id)
      .map(r => ({ viewer: r.viewer as 'user' | 'partner', score: r.score, note: r.note })),
  }));
}

export function addMarathonItem(marathonId: number, title: string, libraryFilename: string | null): MarathonItemRow {
  const db = getDb();
  const position = (db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM marathon_items WHERE marathon_id = ?'
  ).get(marathonId) as { next: number }).next;
  const created_at = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO marathon_items (marathon_id, position, title, library_filename, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(marathonId, position, title, libraryFilename, 'pending', created_at);
  return { id: Number(result.lastInsertRowid), marathon_id: marathonId, position, title, library_filename: libraryFilename, status: 'pending', created_at };
}

export function getMarathonItem(id: number): MarathonItemRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM marathon_items WHERE id = ?').get(id) as unknown as MarathonItemRow | undefined;
}

export function updateMarathonItem(id: number, fields: { title?: string; libraryFilename?: string | null; status?: 'pending' | 'done' | 'skipped' }): void {
  const db = getDb();
  const current = getMarathonItem(id);
  if (!current) return;
  const title = fields.title ?? current.title;
  const libraryFilename = fields.libraryFilename !== undefined ? fields.libraryFilename : current.library_filename;
  const status = fields.status ?? current.status;
  db.prepare('UPDATE marathon_items SET title = ?, library_filename = ?, status = ? WHERE id = ?')
    .run(title, libraryFilename, status, id);
}

export function deleteMarathonItem(id: number): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM marathon_reviews WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM marathon_items WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function moveMarathonItem(marathonId: number, itemId: number, direction: 'up' | 'down'): void {
  const db = getDb();
  const items = db.prepare(
    'SELECT id, position FROM marathon_items WHERE marathon_id = ? ORDER BY position ASC'
  ).all(marathonId) as unknown as { id: number; position: number }[];
  const index = items.findIndex(i => i.id === itemId);
  if (index === -1) return;
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= items.length) return;
  const a = items[index];
  const b = items[swapIndex];
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE marathon_items SET position = ? WHERE id = ?').run(b.position, a.id);
    db.prepare('UPDATE marathon_items SET position = ? WHERE id = ?').run(a.position, b.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function upsertMarathonReview(itemId: number, viewer: 'user' | 'partner', score: number | null, note: string | null): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  db.prepare(`
    INSERT INTO marathon_reviews (item_id, viewer, score, note, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(item_id, viewer) DO UPDATE SET
      score = excluded.score,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(itemId, viewer, score, note, updated_at);
}
```

(Place the new `import type { MarathonRow, ... } from './types';` alongside the existing `import type { RoomRow, LibraryMetaRow, LibraryFileInfo } from './types';` at the top of the file rather than mid-file — mid-file placement above is just for readability in this plan.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx tsx --test tests/marathons-db.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/db.ts server/src/types.ts server/tests/marathons-db.test.ts
git commit -m "Add marathon schema and data-access functions"
```

---

### Task 2: Marathon CRUD routes

**Files:**
- Modify: `server/src/routes.ts` (add routes + import new `db.ts` functions)
- Test: `server/tests/marathons.routes.test.ts` (new file)

**Interfaces:**
- Consumes: all `db.ts` functions from Task 1.
- Produces: `GET/POST /api/marathons`, `GET/PATCH/DELETE /api/marathons/:id` — used by the client Marathons/MarathonDetail pages in Tasks 6-7.

- [ ] **Step 1: Write the failing test**

Create `server/tests/marathons.routes.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

// No password is configured in the fresh temp DATA_DIR used by these tests,
// so requireAdmin() passes every request through open (see its early
// `if (!getPasswordHash()) return;` in server/src/routes.ts) — no login/cookie
// dance needed here. Auth enforcement itself is already covered by auth.test.ts.
describe('marathons routes', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathons-routes-test-'));
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

  it('creates and lists a marathon', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Avengers Marathon' } });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json() as { marathon: { id: number; name: string } };
    assert.equal(created.marathon.name, 'Avengers Marathon');

    const listRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    assert.equal(listRes.statusCode, 200);
    const list = listRes.json() as { marathons: { id: number; name: string }[] };
    assert.ok(list.marathons.some(m => m.id === created.marathon.id));
  });

  it('rejects creating a marathon with an empty name', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: '   ' } });
    assert.equal(res.statusCode, 400);
  });

  it('renames and deletes a marathon', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Temp' } });
    const { marathon } = createRes.json() as { marathon: { id: number } };

    const renameRes = await app.inject({ method: 'PATCH', url: `/api/marathons/${marathon.id}`, payload: { name: 'Renamed' } });
    assert.equal(renameRes.statusCode, 200);

    const getRes = await app.inject({ method: 'GET', url: `/api/marathons/${marathon.id}` });
    assert.equal((getRes.json() as { name: string }).name, 'Renamed');

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/marathons/${marathon.id}` });
    assert.equal(deleteRes.statusCode, 200);

    const afterDelete = await app.inject({ method: 'GET', url: `/api/marathons/${marathon.id}` });
    assert.equal(afterDelete.statusCode, 404);
  });

  it('404s renaming/deleting a marathon that does not exist', async () => {
    const renameRes = await app.inject({ method: 'PATCH', url: '/api/marathons/999999', payload: { name: 'X' } });
    assert.equal(renameRes.statusCode, 404);
    const deleteRes = await app.inject({ method: 'DELETE', url: '/api/marathons/999999' });
    assert.equal(deleteRes.statusCode, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts`
Expected: FAIL — 404s on `/api/marathons` (route doesn't exist yet).

- [ ] **Step 3: Add the routes**

In `server/src/routes.ts`, add `createMarathon, listMarathons, getMarathon, renameMarathon, deleteMarathon` to the existing `import { ... } from './db';` line, then add a new section (placed after the existing `// ── Library: ... ──` section, before the room-related routes):

```ts
// ── Marathons ───────────────────────────────────────────────────────────
app.get('/api/marathons', { preHandler: requireAdmin }, async (_req, reply) => {
  return reply.send({ marathons: listMarathons() });
});

app.post('/api/marathons', { preHandler: requireAdmin }, async (req, reply) => {
  const body = req.body as { name?: string };
  const name = body?.name?.trim();
  if (!name) return reply.status(400).send({ error: 'Name is required' });
  const marathon = createMarathon(name);
  return reply.status(201).send({ marathon });
});

app.get('/api/marathons/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const marathonId = Number(id);
  const marathon = getMarathon(marathonId);
  if (!marathon) return reply.status(404).send({ error: 'Not found' });
  const items = listMarathonItems(marathonId);
  return reply.send({ id: marathon.id, name: marathon.name, items });
});

app.patch('/api/marathons/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const marathonId = Number(id);
  if (!getMarathon(marathonId)) return reply.status(404).send({ error: 'Not found' });
  const body = req.body as { name?: string };
  const name = body?.name?.trim();
  if (!name) return reply.status(400).send({ error: 'Name is required' });
  renameMarathon(marathonId, name);
  return reply.send({ ok: true });
});

app.delete('/api/marathons/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const marathonId = Number(id);
  if (!getMarathon(marathonId)) return reply.status(404).send({ error: 'Not found' });
  deleteMarathon(marathonId);
  return reply.send({ ok: true });
});
```

Note: `/api/marathons/:id` (GET) references `listMarathonItems`, which is added to the `db.ts` import here too even though it's exercised in full by Task 3 — it's needed now because the marathon-detail GET route returns `items` (empty array for a freshly created marathon).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.ts server/tests/marathons.routes.test.ts
git commit -m "Add marathon CRUD routes"
```

---

### Task 3: Marathon item routes (add / update / status / reorder / delete)

**Files:**
- Modify: `server/src/routes.ts` (add item routes)
- Modify: `server/tests/marathons.routes.test.ts` (add a second `describe` block)

**Interfaces:**
- Consumes: `db.ts` functions from Task 1, `assertLibraryPath` (already defined in `routes.ts`, used by the existing rename-library-file handler).
- Produces: `POST /api/marathons/:id/items`, `PATCH /api/marathons/:id/items/:itemId` (also handles `{ move: 'up' | 'down' }`), `DELETE /api/marathons/:id/items/:itemId` — used by Task 7's MarathonDetail page.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/marathons.routes.test.ts` (new top-level `describe`, same file, after the existing one):

```ts
describe('marathon items', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let marathonId: number;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathon-items-test-'));
    process.env.DATA_DIR = dataDir;
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);

    const createRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon' } });
    marathonId = (createRes.json() as { marathon: { id: number } }).marathon.id;
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('adds items and lists them in the marathon detail response', async () => {
    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Iron Man' } });
    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Iron Man 2' } });

    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const body = detail.json() as { items: { title: string }[] };
    assert.deepEqual(body.items.map(i => i.title), ['Iron Man', 'Iron Man 2']);
  });

  it('rejects an item with a library_filename that is not a real library file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/marathons/${marathonId}/items`,
      payload: { title: 'Fake link', libraryFilename: '../../etc/passwd' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('updates status and moves item order', async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items = (detail.json() as { items: { id: number; title: string }[] }).items;
    const [ironMan, ironMan2] = items;

    const statusRes = await app.inject({
      method: 'PATCH', url: `/api/marathons/${marathonId}/items/${ironMan.id}`, payload: { status: 'done' },
    });
    assert.equal(statusRes.statusCode, 200);

    await app.inject({ method: 'PATCH', url: `/api/marathons/${marathonId}/items/${ironMan2.id}`, payload: { move: 'up' } });

    const after = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const afterItems = (after.json() as { items: { id: number; title: string; status: string }[] }).items;
    assert.deepEqual(afterItems.map(i => i.title), ['Iron Man 2', 'Iron Man']);
    assert.equal(afterItems.find(i => i.id === ironMan.id)!.status, 'done');
  });

  it('deletes an item', async () => {
    const addRes = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Deletable' } });
    const item = (addRes.json() as { item: { id: number } }).item;
    const delRes = await app.inject({ method: 'DELETE', url: `/api/marathons/${marathonId}/items/${item.id}` });
    assert.equal(delRes.statusCode, 200);
    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items = (detail.json() as { items: { id: number }[] }).items;
    assert.ok(!items.some(i => i.id === item.id));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts`
Expected: FAIL — 404s on `/api/marathons/:id/items` (route doesn't exist yet).

- [ ] **Step 3: Add the routes**

Add `addMarathonItem, getMarathonItem, updateMarathonItem, deleteMarathonItem, moveMarathonItem` to the `import { ... } from './db';` line in `server/src/routes.ts`, then add (directly after the marathon routes from Task 2):

```ts
// ── Marathon items ─────────────────────────────────────────────────────
app.post('/api/marathons/:id/items', { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const marathonId = Number(id);
  if (!getMarathon(marathonId)) return reply.status(404).send({ error: 'Not found' });
  const body = req.body as { title?: string; libraryFilename?: string | null };
  const title = body?.title?.trim();
  if (!title) return reply.status(400).send({ error: 'Title is required' });
  let libraryFilename: string | null = null;
  if (body.libraryFilename) {
    try { assertLibraryPath(body.libraryFilename); } catch { return reply.status(400).send({ error: 'Invalid library file' }); }
    libraryFilename = body.libraryFilename;
  }
  const item = addMarathonItem(marathonId, title, libraryFilename);
  return reply.status(201).send({ item });
});

app.patch('/api/marathons/:id/items/:itemId', { preHandler: requireAdmin }, async (req, reply) => {
  const { itemId } = req.params as { id: string; itemId: string };
  const item = getMarathonItem(Number(itemId));
  if (!item) return reply.status(404).send({ error: 'Not found' });
  const body = req.body as { title?: string; libraryFilename?: string | null; status?: string; move?: 'up' | 'down' };

  if (body.move) {
    moveMarathonItem(item.marathon_id, item.id, body.move);
    return reply.send({ ok: true });
  }

  if (body.status && !['pending', 'done', 'skipped'].includes(body.status)) {
    return reply.status(400).send({ error: 'Invalid status' });
  }
  let libraryFilename: string | null | undefined;
  if (body.libraryFilename !== undefined) {
    if (body.libraryFilename) {
      try { assertLibraryPath(body.libraryFilename); } catch { return reply.status(400).send({ error: 'Invalid library file' }); }
    }
    libraryFilename = body.libraryFilename;
  }
  updateMarathonItem(item.id, {
    title: body.title?.trim(),
    libraryFilename,
    status: body.status as 'pending' | 'done' | 'skipped' | undefined,
  });
  return reply.send({ ok: true });
});

app.delete('/api/marathons/:id/items/:itemId', { preHandler: requireAdmin }, async (req, reply) => {
  const { itemId } = req.params as { id: string; itemId: string };
  const item = getMarathonItem(Number(itemId));
  if (!item) return reply.status(404).send({ error: 'Not found' });
  deleteMarathonItem(item.id);
  return reply.send({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts`
Expected: PASS — all tests in both `describe` blocks green.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.ts server/tests/marathons.routes.test.ts
git commit -m "Add marathon item routes (add, update, reorder, delete)"
```

---

### Task 4: Review upsert route

**Files:**
- Modify: `server/src/routes.ts` (add review route)
- Modify: `server/tests/marathons.routes.test.ts` (add a third `describe` block)

**Interfaces:**
- Consumes: `upsertMarathonReview` from Task 1.
- Produces: `PUT /api/marathons/:id/items/:itemId/review` — used by Task 7's review editor.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/marathons.routes.test.ts`:

```ts
describe('marathon item reviews', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let itemId: number;
  let marathonId: number;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathon-reviews-test-'));
    process.env.DATA_DIR = dataDir;
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);

    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Review Test Marathon' } });
    marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;
    const itemRes = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Thor' } });
    itemId = (itemRes.json() as { item: { id: number } }).item.id;
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('saves independent reviews per viewer', async () => {
    await app.inject({
      method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`,
      payload: { viewer: 'user', score: 6, note: 'meh' },
    });
    await app.inject({
      method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`,
      payload: { viewer: 'partner', score: 5, note: null },
    });

    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const item = (detail.json() as { items: { reviews: { viewer: string; score: number | null; note: string | null }[] }[] }).items[0];
    assert.deepEqual(item.reviews.find(r => r.viewer === 'user'), { viewer: 'user', score: 6, note: 'meh' });
    assert.deepEqual(item.reviews.find(r => r.viewer === 'partner'), { viewer: 'partner', score: 5, note: null });
  });

  it('re-saving the same viewer updates rather than duplicates', async () => {
    await app.inject({ method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`, payload: { viewer: 'user', score: 9, note: 'actually great' } });
    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const item = (detail.json() as { items: { reviews: { viewer: string; score: number | null }[] }[] }).items[0];
    assert.equal(item.reviews.filter(r => r.viewer === 'user').length, 1);
    assert.equal(item.reviews.find(r => r.viewer === 'user')!.score, 9);
  });

  it('rejects an invalid viewer or out-of-range score', async () => {
    const badViewer = await app.inject({ method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`, payload: { viewer: 'stranger', score: 5 } });
    assert.equal(badViewer.statusCode, 400);
    const badScore = await app.inject({ method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`, payload: { viewer: 'user', score: 11 } });
    assert.equal(badScore.statusCode, 400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts`
Expected: FAIL — 404 on `PUT /api/marathons/:id/items/:itemId/review`.

- [ ] **Step 3: Add the route**

Add `upsertMarathonReview` to the `import { ... } from './db';` line in `server/src/routes.ts`, then add (after the marathon item routes):

```ts
// ── Marathon item reviews ──────────────────────────────────────────────
app.put('/api/marathons/:id/items/:itemId/review', { preHandler: requireAdmin }, async (req, reply) => {
  const { itemId } = req.params as { id: string; itemId: string };
  const item = getMarathonItem(Number(itemId));
  if (!item) return reply.status(404).send({ error: 'Not found' });
  const body = req.body as { viewer?: string; score?: number | null; note?: string | null };
  if (body.viewer !== 'user' && body.viewer !== 'partner') {
    return reply.status(400).send({ error: 'Invalid viewer' });
  }
  if (body.score !== null && body.score !== undefined) {
    if (!Number.isInteger(body.score) || body.score < 1 || body.score > 10) {
      return reply.status(400).send({ error: 'Score must be an integer from 1 to 10' });
    }
  }
  upsertMarathonReview(item.id, body.viewer, body.score ?? null, body.note?.trim() || null);
  return reply.send({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx tsx --test tests/marathons.routes.test.ts`
Expected: PASS — all tests across all three `describe` blocks green.

- [ ] **Step 5: Full server test suite + typecheck**

Run: `cd server && npm test && npx tsc --noEmit`
Expected: all server tests pass (including pre-existing `auth.test.ts`, `subtitles.test.ts`, etc.), no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes.ts server/tests/marathons.routes.test.ts
git commit -m "Add marathon item review route"
```

---

### Task 5: Client viewer identity + who's-watching screen

**Files:**
- Create: `client/src/lib/viewer.ts`
- Create: `client/src/pages/WhosWatching.tsx`
- Modify: `client/src/App.tsx` (register `/whos-watching` route)
- Modify: `client/src/index.css` (add who's-watching styles)

**Interfaces:**
- Produces (used by Tasks 6-8): `type Viewer = 'user' | 'partner'`, `getViewer(): Viewer | null`, `setViewer(v: Viewer): void`, `clearViewer(): void`

- [ ] **Step 1: Create the viewer helper**

Create `client/src/lib/viewer.ts`:

```ts
export type Viewer = 'user' | 'partner';

const STORAGE_KEY = 'pf_viewer';

export function getViewer(): Viewer | null {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'user' || value === 'partner' ? value : null;
}

export function setViewer(viewer: Viewer): void {
  localStorage.setItem(STORAGE_KEY, viewer);
}

export function clearViewer(): void {
  localStorage.removeItem(STORAGE_KEY);
}
```

- [ ] **Step 2: Create the who's-watching page**

Create `client/src/pages/WhosWatching.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setViewer, type Viewer } from '../lib/viewer';

interface Names {
  USER_NAME: string;
  PARTNER_NAME: string;
}

export function WhosWatching() {
  const navigate = useNavigate();
  const [names, setNames] = useState<Names | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: { USER_NAME?: string; PARTNER_NAME?: string }) => {
        setNames({
          USER_NAME: d.USER_NAME?.trim() || 'Person 1',
          PARTNER_NAME: d.PARTNER_NAME?.trim() || 'Person 2',
        });
      })
      .catch(() => setNames({ USER_NAME: 'Person 1', PARTNER_NAME: 'Person 2' }));
  }, []);

  const choose = (viewer: Viewer) => {
    setViewer(viewer);
    navigate('/');
  };

  if (!names) return null;

  return (
    <div className="whos-watching-root">
      <h1 className="whos-watching-title">Who's watching?</h1>
      <div className="whos-watching-tiles">
        <button className="profile-tile" onClick={() => choose('user')}>
          <span className="profile-avatar">{names.USER_NAME.charAt(0).toUpperCase()}</span>
          <span className="profile-name">{names.USER_NAME}</span>
        </button>
        <button className="profile-tile" onClick={() => choose('partner')}>
          <span className="profile-avatar">{names.PARTNER_NAME.charAt(0).toUpperCase()}</span>
          <span className="profile-name">{names.PARTNER_NAME}</span>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register the route**

In `client/src/App.tsx`, add the import and route:

```tsx
import { WhosWatching } from './pages/WhosWatching';
```

```tsx
<Route path="/whos-watching" element={<WhosWatching />} />
```
(add directly above the existing `<Route path="*" element={<Navigate to="/" replace />} />` line)

- [ ] **Step 4: Add styles**

In `client/src/index.css`, add:

```css
/* Who's watching */
.whos-watching-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-lg);
  background: var(--bg);
  padding: var(--space-xl);
}

.whos-watching-title {
  font-size: 1.75rem;
  font-weight: 600;
  color: var(--text);
}

.whos-watching-tiles {
  display: flex;
  gap: var(--space-xl);
}

.profile-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-md);
  border-radius: var(--radius-lg);
  transition: transform var(--dur-short) var(--ease-out);
}

.profile-tile:hover,
.profile-tile:focus-visible {
  transform: scale(1.05);
  outline: none;
}

.profile-avatar {
  width: 96px;
  height: 96px;
  border-radius: var(--radius-lg);
  background: var(--accent);
  color: var(--accent-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.5rem;
  font-weight: 700;
}

.profile-name {
  color: var(--text-muted);
  font-size: 1rem;
}
```

- [ ] **Step 5: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 6: Manual verification**

Run: `cd client && npm run dev` (and the server in another terminal per this project's usual dev workflow), navigate to `/whos-watching` directly in the browser. Expected: two tiles showing your Settings names (or "Person 1"/"Person 2" if unset), clicking one navigates to `/` and stores the choice (`localStorage.getItem('pf_viewer')` in devtools should show `"user"` or `"partner"`).

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/viewer.ts client/src/pages/WhosWatching.tsx client/src/App.tsx client/src/index.css
git commit -m "Add who's-watching profile-select screen"
```

---

### Task 6: Client Marathons list page

**Files:**
- Create: `client/src/pages/Marathons.tsx`
- Modify: `client/src/App.tsx` (register `/marathons` route)
- Modify: `client/src/index.css` (add marathons-list styles)

**Interfaces:**
- Consumes: `GET /api/marathons`, `POST /api/marathons` (Task 2); `clearViewer` (Task 5).

- [ ] **Step 1: Create the page**

Create `client/src/pages/Marathons.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Users } from 'lucide-react';
import { clearViewer } from '../lib/viewer';

interface MarathonSummary {
  id: number;
  name: string;
  position: number;
  itemCount: number;
  doneCount: number;
}

export function Marathons() {
  const navigate = useNavigate();
  const [marathons, setMarathons] = useState<MarathonSummary[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetch('/api/marathons')
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        setAuthed(true);
        return r.json();
      })
      .then((d: { marathons: MarathonSummary[] } | null) => { if (d) setMarathons(d.marathons); })
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const createMarathon = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/marathons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json() as { marathon?: { id: number }; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      navigate(`/marathons/${data.marathon!.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setCreating(false);
    }
  };

  const switchProfile = () => {
    clearViewer();
    navigate('/whos-watching');
  };

  if (authed === false) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/" className="settings-link" title="Back to library"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">Please sign in to view marathons.</div>
      </div>
    );
  }
  if (authed === null) return null;

  return (
    <div className="home-root">
      <header className="home-topbar">
        <Link to="/" className="settings-link" title="Back to library"><ArrowLeft /></Link>
        <h1 className="marathons-heading">Marathons</h1>
        <button className="settings-link" title="Switch profile" onClick={switchProfile}><Users /></button>
      </header>

      <form className="marathon-new-form" onSubmit={createMarathon}>
        <input
          className="setup-input"
          placeholder="New marathon name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
        />
        <button type="submit" className="primary-btn" disabled={creating || !newName.trim()}>
          <Plus size={16} /> Create
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}

      <div className="marathon-card-grid">
        {marathons.map(m => (
          <Link key={m.id} to={`/marathons/${m.id}`} className="marathon-card">
            <div className="marathon-card-name">{m.name}</div>
            <div className="marathon-card-progress">{m.doneCount}/{m.itemCount} done</div>
          </Link>
        ))}
        {marathons.length === 0 && (
          <div className="marathons-empty">No marathons yet — create one above.</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

In `client/src/App.tsx`, add:

```tsx
import { Marathons } from './pages/Marathons';
```

```tsx
<Route path="/marathons" element={<Marathons />} />
```
(directly above `<Route path="/whos-watching" ...>` or in any order within the `<Routes>` block, as long as it's before the catch-all `*` route)

- [ ] **Step 3: Add styles**

In `client/src/index.css`, add:

```css
/* Marathons list */
.marathons-heading {
  flex: 1;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text);
  margin: 0 var(--space-sm);
}

.marathon-new-form {
  display: flex;
  gap: var(--space-sm);
  padding: var(--space-md);
  align-items: center;
  flex-wrap: wrap;
}

.marathon-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-md);
  padding: var(--space-md);
}

.marathon-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-md);
  text-decoration: none;
  box-shadow: var(--shadow-card);
  transition: transform var(--dur-short) var(--ease-out);
}

.marathon-card:hover {
  transform: translateY(-2px);
}

.marathon-card-name {
  color: var(--text);
  font-weight: 600;
  margin-bottom: var(--space-2xs);
}

.marathon-card-progress {
  color: var(--text-subtle);
  font-size: 0.85rem;
}

.marathons-empty {
  color: var(--text-subtle);
  padding: var(--space-lg);
}

.marathons-signed-out {
  padding: var(--space-xl);
  color: var(--text-muted);
  text-align: center;
}

.form-error {
  color: var(--danger);
  padding: 0 var(--space-md);
  font-size: 0.85rem;
}
```

- [ ] **Step 4: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 5: Manual verification**

With dev servers running, navigate to `/marathons`. Expected: empty state message, creating a marathon via the form navigates to `/marathons/:id` (a 404-ish blank page is fine — that's Task 7).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Marathons.tsx client/src/App.tsx client/src/index.css
git commit -m "Add marathons list page"
```

---

### Task 7: Client Marathon detail page

**Files:**
- Create: `client/src/pages/MarathonDetail.tsx`
- Modify: `client/src/App.tsx` (register `/marathons/:id` route)
- Modify: `client/src/index.css` (add item-row/review-editor styles)

**Interfaces:**
- Consumes: `GET/PATCH/DELETE /api/marathons/:id`, item and review routes (Tasks 2-4); `GET /api/library` (existing); `POST /api/rooms` (existing, used to start playback of a linked file); `getViewer`/`clearViewer` (Task 5).

- [ ] **Step 1: Create the page**

Create `client/src/pages/MarathonDetail.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUp, ArrowDown, Plus, Trash2, Users } from 'lucide-react';
import { getViewer, clearViewer, type Viewer } from '../lib/viewer';

type Status = 'pending' | 'done' | 'skipped';

interface Review {
  viewer: Viewer;
  score: number | null;
  note: string | null;
}

interface Item {
  id: number;
  position: number;
  title: string;
  libraryFilename: string | null;
  status: Status;
  reviews: Review[];
}

interface LibraryFile {
  filename: string;
}

const STATUS_LABEL: Record<Status, string> = {
  pending: 'Pending',
  done: 'Done',
  skipped: 'Skipped',
};

export function MarathonDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const viewer = getViewer();

  const [name, setName] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newLibraryFilename, setNewLibraryFilename] = useState('');
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [draftScore, setDraftScore] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetch(`/api/marathons/${id}`)
      .then(r => {
        if (r.status === 401) { setAuthed(false); return null; }
        setAuthed(true);
        return r.json();
      })
      .then((d: { name: string; items: Item[] } | null) => {
        if (d) { setName(d.name); setItems(d.items); }
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!viewer) { navigate('/whos-watching'); return; }
    load();
    fetch('/api/library')
      .then(r => r.json())
      .then((d: { files: LibraryFile[] }) => setLibraryFiles(d.files))
      .catch(() => {});
  }, [load, viewer, navigate]);

  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setError('');
    try {
      const res = await fetch(`/api/marathons/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, libraryFilename: newLibraryFilename || null }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setNewTitle('');
      setNewLibraryFilename('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const setStatus = async (itemId: number, status: Status) => {
    await fetch(`/api/marathons/${id}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    load();
  };

  const move = async (itemId: number, direction: 'up' | 'down') => {
    await fetch(`/api/marathons/${id}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: direction }),
    });
    load();
  };

  const deleteItem = async (itemId: number) => {
    if (!window.confirm('Remove this item from the marathon?')) return;
    await fetch(`/api/marathons/${id}/items/${itemId}`, { method: 'DELETE' });
    load();
  };

  const deleteMarathon = async () => {
    if (!window.confirm(`Delete "${name}" and all its items and reviews?`)) return;
    await fetch(`/api/marathons/${id}`, { method: 'DELETE' });
    navigate('/marathons');
  };

  const playLinkedFile = async (filename: string) => {
    setError('');
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json() as { roomToken?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to start room');
      navigate(`/room/${data.roomToken!}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start room');
    }
  };

  const startEditingReview = (item: Item) => {
    const mine = item.reviews.find(r => r.viewer === viewer);
    setEditingItemId(item.id);
    setDraftScore(mine?.score != null ? String(mine.score) : '');
    setDraftNote(mine?.note ?? '');
  };

  const isLinkedFileAvailable = (filename: string) => libraryFiles.some(f => f.filename === filename);

  const saveReview = async (itemId: number) => {
    if (!viewer) return;
    const score = draftScore.trim() ? Number(draftScore) : null;
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 10)) {
      setError('Score must be a whole number from 1 to 10');
      return;
    }
    setError('');
    await fetch(`/api/marathons/${id}/items/${itemId}/review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, score, note: draftNote.trim() || null }),
    });
    setEditingItemId(null);
    load();
  };

  const switchProfile = () => {
    clearViewer();
    navigate('/whos-watching');
  };

  if (authed === false) {
    return (
      <div className="home-root">
        <header className="home-topbar">
          <Link to="/marathons" className="settings-link" title="Back to marathons"><ArrowLeft /></Link>
        </header>
        <div className="marathons-signed-out">Please sign in to view this marathon.</div>
      </div>
    );
  }
  if (authed === null || !viewer) return null;

  return (
    <div className="home-root">
      <header className="home-topbar">
        <Link to="/marathons" className="settings-link" title="Back to marathons"><ArrowLeft /></Link>
        <h1 className="marathons-heading">{name}</h1>
        <button className="settings-link" title="Switch profile" onClick={switchProfile}><Users /></button>
        <button className="settings-link" title="Delete marathon" onClick={deleteMarathon}><Trash2 /></button>
      </header>

      {error && <div className="form-error">{error}</div>}

      <ul className="marathon-item-list">
        {items.map((item, index) => (
          <li key={item.id} className="marathon-item-row">
            <div className="marathon-item-move">
              <button disabled={index === 0} onClick={() => move(item.id, 'up')} title="Move up"><ArrowUp size={14} /></button>
              <button disabled={index === items.length - 1} onClick={() => move(item.id, 'down')} title="Move down"><ArrowDown size={14} /></button>
            </div>

            <div className="marathon-item-main">
              {item.libraryFilename && isLinkedFileAvailable(item.libraryFilename) ? (
                <button
                  type="button"
                  className="marathon-item-title marathon-item-title-linked"
                  onClick={() => playLinkedFile(item.libraryFilename!)}
                >
                  {item.title}
                </button>
              ) : (
                <span className="marathon-item-title">{item.title}</span>
              )}

              <div className="marathon-item-scores">
                {(['user', 'partner'] as Viewer[]).map(v => {
                  const r = item.reviews.find(rv => rv.viewer === v);
                  return (
                    <span key={v} className="marathon-item-score">
                      {v === 'user' ? 'U' : 'P'}: {r?.score != null ? `${r.score}/10` : '—'}
                    </span>
                  );
                })}
              </div>
            </div>

            <select
              className="marathon-status-select"
              value={item.status}
              onChange={e => setStatus(item.id, e.target.value as Status)}
            >
              <option value="pending">{STATUS_LABEL.pending}</option>
              <option value="done">{STATUS_LABEL.done}</option>
              <option value="skipped">{STATUS_LABEL.skipped}</option>
            </select>

            <button className="settings-link" title="Rate" onClick={() => startEditingReview(item)}>Review</button>
            <button className="settings-link" title="Delete item" onClick={() => deleteItem(item.id)}><Trash2 size={14} /></button>

            {editingItemId === item.id && (
              <div className="marathon-review-editor">
                <input
                  className="setup-input"
                  type="number"
                  min={1}
                  max={10}
                  placeholder="Score (1-10)"
                  value={draftScore}
                  onChange={e => setDraftScore(e.target.value)}
                />
                <input
                  className="setup-input"
                  placeholder="Note (optional)"
                  value={draftNote}
                  onChange={e => setDraftNote(e.target.value)}
                />
                <button className="primary-btn" onClick={() => saveReview(item.id)}>Save</button>
                <button className="settings-link" onClick={() => setEditingItemId(null)}>Cancel</button>
              </div>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="marathons-empty">No items yet — add one below.</li>}
      </ul>

      <form className="marathon-new-form" onSubmit={addItem}>
        <input
          className="setup-input"
          placeholder="Movie title"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
        />
        <select
          className="marathon-status-select"
          value={newLibraryFilename}
          onChange={e => setNewLibraryFilename(e.target.value)}
        >
          <option value="">Not in library</option>
          {libraryFiles.map(f => (
            <option key={f.filename} value={f.filename}>{f.filename}</option>
          ))}
        </select>
        <button type="submit" className="primary-btn" disabled={!newTitle.trim()}>
          <Plus size={16} /> Add
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

In `client/src/App.tsx`, add:

```tsx
import { MarathonDetail } from './pages/MarathonDetail';
```

```tsx
<Route path="/marathons/:id" element={<MarathonDetail />} />
```
(above the catch-all `*` route)

- [ ] **Step 3: Add styles**

In `client/src/index.css`, add:

```css
/* Marathon detail */
.marathon-item-list {
  list-style: none;
  margin: 0;
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.marathon-item-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-sm) var(--space-md);
  flex-wrap: wrap;
}

.marathon-item-move {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.marathon-item-move button {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}

.marathon-item-move button:disabled {
  opacity: 0.3;
  cursor: default;
}

.marathon-item-main {
  flex: 1;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3xs);
}

.marathon-item-title {
  color: var(--text);
  font-weight: 500;
}

.marathon-item-title-linked {
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  color: var(--accent);
  padding: 0;
  font: inherit;
}

.marathon-item-scores {
  display: flex;
  gap: var(--space-sm);
  font-size: 0.8rem;
  color: var(--text-subtle);
}

.marathon-status-select {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: var(--space-3xs) var(--space-xs);
}

.marathon-review-editor {
  width: 100%;
  display: flex;
  gap: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border);
  margin-top: var(--space-sm);
  flex-wrap: wrap;
}
```

- [ ] **Step 4: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 5: Manual verification**

With dev servers running and a viewer already selected (from Task 5's manual test): open a marathon, add a few items (one linked to a real library file, one plain title), mark one done, move an item up/down, open "Review" on an item and save a score+note, confirm it shows as `U: 9/10` (or `P:`) inline. Tap a linked item's title and confirm it starts a room/player. Delete an item and the marathon itself, confirming the `window.confirm` prompts appear.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/MarathonDetail.tsx client/src/App.tsx client/src/index.css
git commit -m "Add marathon detail page with items, status, and reviews"
```

---

### Task 8: Wire Home.tsx — nav entry, switch-profile icon, auto-redirect to who's-watching

**Files:**
- Modify: `client/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `getViewer`, `clearViewer` (Task 5).

- [ ] **Step 1: Add the redirect-to-who's-watching effect**

In `client/src/pages/Home.tsx`, add the import:

```tsx
import { getViewer, clearViewer } from '../lib/viewer';
```

Add a new effect alongside the existing auth-check effect (the one that does `fetch('/api/auth/me')...setAuthed(...)`):

```tsx
useEffect(() => {
  if (authed && !getViewer()) {
    navigate('/whos-watching');
  }
}, [authed, navigate]);
```

(This assumes `navigate` from `useNavigate()` is already in scope in `Home.tsx` — confirmed by its existing `createRoomFrom` function, which already calls `navigate(...)`.)

- [ ] **Step 2: Add nav entry + switch-profile icon to the topbar**

Find the existing topbar block in `Home.tsx`:

```tsx
<header className="home-topbar">
  <span className="home-logo"><Logo size="sm" variant={theme} /></span>
  <Link to="/settings" className="settings-link" title="Settings"><Settings /></Link>
</header>
```

Replace it with:

```tsx
<header className="home-topbar">
  <span className="home-logo"><Logo size="sm" variant={theme} /></span>
  <Link to="/marathons" className="settings-link" title="Marathons"><ListChecks /></Link>
  <button className="settings-link" title="Switch profile" onClick={() => { clearViewer(); navigate('/whos-watching'); }}><Users /></button>
  <Link to="/settings" className="settings-link" title="Settings"><Settings /></Link>
</header>
```

Add `ListChecks` and `Users` to the existing `lucide-react` import at the top of `Home.tsx` (the one that already imports `Play, Pause, ..., Settings, Upload, ...`).

- [ ] **Step 3: Typecheck and build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 4: Manual full-flow verification**

With both dev servers running (server + client, or the built client served by the server per `DEVELOPMENT.md`):
1. Clear `localStorage` and log in fresh with the household password.
2. Confirm you land on `/whos-watching` automatically (not Home).
3. Pick a profile tile, confirm you land on Home, and the topbar shows a Marathons icon and a switch-profile icon.
4. Click into Marathons, create "Avengers Marathon", add a few items, mark statuses, leave a review as the current profile.
5. Click switch-profile, pick the other tile, open the same marathon, and confirm you can independently leave the second review without disturbing the first.
6. Confirm the reviewed scores now show both `U:` and `P:` values on the item row.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Home.tsx
git commit -m "Wire Home nav to marathons and who's-watching switch"
```

---

## Post-plan note

No box/production deploy is part of this plan — per the user's explicit instruction, build and test locally only, and wait for a separate go-ahead before deploying to `twogether-box`.
