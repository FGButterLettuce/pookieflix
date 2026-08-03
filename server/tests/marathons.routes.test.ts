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

// Shared setup for all marathon tests — single app instance, single temp DATA_DIR
let app: FastifyInstance;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathons-test-'));
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

describe('marathons routes', () => {
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

describe('marathon items', () => {
  it('adds items and lists them in the marathon detail response', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 1' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Iron Man' } });
    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Iron Man 2' } });

    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const body = detail.json() as { items: { title: string }[] };
    assert.deepEqual(body.items.map(i => i.title), ['Iron Man', 'Iron Man 2']);
  });

  it('rejects an item with a library_filename that is not a real library file', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 2' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/marathons/${marathonId}/items`,
      payload: { title: 'Fake link', libraryFilename: '../../etc/passwd' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects PATCH with library_filename that is not a real library file', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 3' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    const itemRes = await app.inject({
      method: 'POST',
      url: `/api/marathons/${marathonId}/items`,
      payload: { title: 'Valid item' },
    });
    const itemId = (itemRes.json() as { item: { id: number } }).item.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/marathons/${marathonId}/items/${itemId}`,
      payload: { libraryFilename: '../../etc/passwd' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('updates status and moves item order', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 4' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Iron Man' } });
    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Iron Man 2' } });

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

  it('rejects PATCH with empty/whitespace-only title', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 5' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    const itemRes = await app.inject({
      method: 'POST',
      url: `/api/marathons/${marathonId}/items`,
      payload: { title: 'Original Title' },
    });
    const itemId = (itemRes.json() as { item: { id: number } }).item.id;

    const emptyRes = await app.inject({
      method: 'PATCH',
      url: `/api/marathons/${marathonId}/items/${itemId}`,
      payload: { title: '' },
    });
    assert.equal(emptyRes.statusCode, 400);

    const whitespaceRes = await app.inject({
      method: 'PATCH',
      url: `/api/marathons/${marathonId}/items/${itemId}`,
      payload: { title: '   ' },
    });
    assert.equal(whitespaceRes.statusCode, 400);

    // Verify title was not changed
    const checkRes = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const detail = checkRes.json() as { items: { id: number; title: string }[] };
    const item = detail.items.find(i => i.id === itemId);
    assert.equal(item!.title, 'Original Title');
  });

  it('deletes an item', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 6' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    const addRes = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Deletable' } });
    const item = (addRes.json() as { item: { id: number } }).item;
    const delRes = await app.inject({ method: 'DELETE', url: `/api/marathons/${marathonId}/items/${item.id}` });
    assert.equal(delRes.statusCode, 200);
    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items = (detail.json() as { items: { id: number }[] }).items;
    assert.ok(!items.some(i => i.id === item.id));
  });

  it('rejects PATCH/DELETE item with wrong marathon id in URL', async () => {
    const marathon1 = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 7a' } });
    const marathonId1 = (marathon1.json() as { marathon: { id: number } }).marathon.id;

    const marathon2 = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 7b' } });
    const marathonId2 = (marathon2.json() as { marathon: { id: number } }).marathon.id;

    const itemRes = await app.inject({
      method: 'POST',
      url: `/api/marathons/${marathonId1}/items`,
      payload: { title: 'Item in marathon 1' },
    });
    const itemId = (itemRes.json() as { item: { id: number } }).item.id;

    // Try to PATCH item using wrong marathon id in URL
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/marathons/${marathonId2}/items/${itemId}`,
      payload: { status: 'done' },
    });
    assert.equal(patchRes.statusCode, 404);

    // Try to DELETE item using wrong marathon id in URL
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/marathons/${marathonId2}/items/${itemId}`,
    });
    assert.equal(deleteRes.statusCode, 404);

    // Verify item still exists in its original marathon
    const checkRes = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId1}` });
    const items = (checkRes.json() as { items: { id: number }[] }).items;
    assert.ok(items.some(i => i.id === itemId));
  });

  it('move first item up is a no-op', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 8' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'First' } });
    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Second' } });

    const detail1 = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items1 = (detail1.json() as { items: { id: number; title: string }[] }).items;
    const firstItemId = items1[0].id;

    // Try to move first item up (should no-op)
    await app.inject({
      method: 'PATCH',
      url: `/api/marathons/${marathonId}/items/${firstItemId}`,
      payload: { move: 'up' },
    });

    const detail2 = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items2 = (detail2.json() as { items: { id: number; title: string }[] }).items;
    assert.deepEqual(
      items2.map(i => i.title),
      ['First', 'Second'],
    );
  });

  it('move last item down is a no-op', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 9' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'First' } });
    await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Second' } });

    const detail1 = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items1 = (detail1.json() as { items: { id: number; title: string }[] }).items;
    const lastItemId = items1[items1.length - 1].id;

    // Try to move last item down (should no-op)
    await app.inject({
      method: 'PATCH',
      url: `/api/marathons/${marathonId}/items/${lastItemId}`,
      payload: { move: 'down' },
    });

    const detail2 = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const items2 = (detail2.json() as { items: { id: number; title: string }[] }).items;
    assert.deepEqual(
      items2.map(i => i.title),
      ['First', 'Second'],
    );
  });

  it('reorders via a direct position instead of move up/down', async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Item Test Marathon 10' } });
    const marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;

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
});

describe('marathon item reviews', () => {
  let itemId: number;
  let marathonId: number;

  before(async () => {
    const marathonRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Review Test Marathon' } });
    marathonId = (marathonRes.json() as { marathon: { id: number } }).marathon.id;
    const itemRes = await app.inject({ method: 'POST', url: `/api/marathons/${marathonId}/items`, payload: { title: 'Thor' } });
    itemId = (itemRes.json() as { item: { id: number } }).item.id;
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

  it('rejects PUT review with wrong marathon id in URL', async () => {
    const marathon1 = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Review Test Marathon 2a' } });
    const marathonId1 = (marathon1.json() as { marathon: { id: number } }).marathon.id;

    const marathon2 = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Review Test Marathon 2b' } });
    const marathonId2 = (marathon2.json() as { marathon: { id: number } }).marathon.id;

    const itemRes = await app.inject({
      method: 'POST',
      url: `/api/marathons/${marathonId1}/items`,
      payload: { title: 'Item in marathon 1' },
    });
    const wrongItemId = (itemRes.json() as { item: { id: number } }).item.id;

    // Try to PUT a review using the other marathon's id in the URL
    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/marathons/${marathonId2}/items/${wrongItemId}/review`,
      payload: { viewer: 'user', score: 8, note: 'sneaky' },
    });
    assert.equal(putRes.statusCode, 404);

    // Verify no review was saved against the item in its real marathon
    const checkRes = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId1}` });
    const checkItem = (checkRes.json() as { items: { reviews: { viewer: string }[] }[] }).items[0];
    assert.equal(checkItem.reviews.length, 0);
  });

  it('accepts and persists a half-point score', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`,
      payload: { viewer: 'user', score: 8.5, note: null },
    });
    assert.equal(res.statusCode, 200);

    const detail = await app.inject({ method: 'GET', url: `/api/marathons/${marathonId}` });
    const item = (detail.json() as { items: { reviews: { viewer: string; score: number | null }[] }[] }).items.find(i => i.id === itemId)!;
    assert.equal(item.reviews.find(r => r.viewer === 'user')!.score, 8.5);
  });

  it('still rejects a score off the half-point grid, e.g. 8.3', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`,
      payload: { viewer: 'user', score: 8.3, note: null },
    });
    assert.equal(res.statusCode, 400);
  });

  it('still rejects out-of-range scores like 0.5 or 10.5', async () => {
    const low = await app.inject({ method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`, payload: { viewer: 'user', score: 0.5 } });
    assert.equal(low.statusCode, 400);
    const high = await app.inject({ method: 'PUT', url: `/api/marathons/${marathonId}/items/${itemId}/review`, payload: { viewer: 'user', score: 10.5 } });
    assert.equal(high.statusCode, 400);
  });
});
