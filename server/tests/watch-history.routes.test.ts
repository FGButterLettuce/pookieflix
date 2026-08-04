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
    fs.mkdirSync(path.join(mediaDir, 'Another.Movie.2023.hls'));

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
    assert.ok(entries.some(e => e.title === 'The Terminal'));
    assert.ok(entries.some(e => e.title === 'Another Movie'));
  });

  it('dismisses an entry, and dismissed entries do not reappear on rescan', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entries = (listRes.json() as { entries: { id: number; title: string }[] }).entries;
    const terminalEntry = entries.find(e => e.title === 'The Terminal')!;
    const movieEntry = entries.find(e => e.title === 'Another Movie')!;

    // Dismiss the Terminal entry
    const delRes = await app.inject({ method: 'DELETE', url: `/api/history/${terminalEntry.id}` });
    assert.equal(delRes.statusCode, 200);

    // Verify it's gone from the list
    let after = await app.inject({ method: 'GET', url: '/api/history' });
    assert.ok(!(after.json() as { entries: { id: number }[] }).entries.some(e => e.id === terminalEntry.id));
    assert.ok((after.json() as { entries: { id: number }[] }).entries.some(e => e.id === movieEntry.id));

    // Rescan (dismiss is permanent — dismissed entry should NOT reappear)
    await app.inject({ method: 'POST', url: '/api/history/scan' });
    after = await app.inject({ method: 'GET', url: '/api/history' });
    const afterEntries = (after.json() as { entries: { id: number; title: string }[] }).entries;
    assert.ok(!afterEntries.some(e => e.title === 'The Terminal'), 'dismissed entry must not reappear on rescan');
    assert.ok(afterEntries.some(e => e.title === 'Another Movie'), 'non-dismissed entry must still appear after rescan');
  });

  it('promotes a history entry into a list — entry stays in history (a permanent record), and shows up in addedTo', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entries = (listRes.json() as { entries: { id: number; title: string }[] }).entries;
    const movieEntry = entries.find(e => e.title === 'Another Movie')!;

    const promoteRes = await app.inject({
      method: 'POST', url: `/api/history/${movieEntry.id}/promote`, payload: { marathonName: 'Watched Archive' },
    });
    assert.equal(promoteRes.statusCode, 201);
    const body = promoteRes.json() as { item: { id: number; title: string }; marathonId: number; addedTo: { marathonId: number; marathonName: string }[] };
    assert.equal(body.item.title, 'Another Movie');
    assert.deepEqual(body.addedTo, [{ marathonId: body.marathonId, marathonName: 'Watched Archive' }]);

    const marathonsRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    const marathons = (marathonsRes.json() as { marathons: { id: number; name: string }[] }).marathons;
    assert.ok(marathons.some(m => m.id === body.marathonId && m.name === 'Watched Archive'));

    // Watch history is a permanent record (like a library, per Niranjan's
    // "think of it like playlists" framing) — promoting is additive, never
    // removes the entry, so it must still be here and show what it's been
    // added to.
    const afterPromoteRes = await app.inject({ method: 'GET', url: '/api/history' });
    const afterPromoteEntries = (afterPromoteRes.json() as { entries: { id: number; addedTo: { marathonId: number; marathonName: string }[] }[] }).entries;
    const stillThere = afterPromoteEntries.find(e => e.id === movieEntry.id);
    assert.ok(stillThere, 'promoted entry must remain in history, not disappear');
    assert.deepEqual(stillThere.addedTo, [{ marathonId: body.marathonId, marathonName: 'Watched Archive' }]);

    // Re-promoting into the SAME list is idempotent — reuses the existing
    // item instead of creating a duplicate.
    const repeatRes = await app.inject({
      method: 'POST', url: `/api/history/${movieEntry.id}/promote`, payload: { marathonName: 'Watched Archive' },
    });
    assert.equal(repeatRes.statusCode, 201);
    const repeatBody = repeatRes.json() as { item: { id: number } };
    assert.equal(repeatBody.item.id, body.item.id, 'repeat promote into the same list must reuse the existing item, not create a new one');
  });

  it('promoting the same entry into a second, different list adds it there too (playlist-style), without duplicating in the first', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entries = (listRes.json() as { entries: { id: number; title: string }[] }).entries;
    const movieEntry = entries.find(e => e.title === 'Another Movie')!;

    const promoteRes = await app.inject({
      method: 'POST', url: `/api/history/${movieEntry.id}/promote`, payload: { marathonName: 'Second List' },
    });
    assert.equal(promoteRes.statusCode, 201);

    const afterRes = await app.inject({ method: 'GET', url: '/api/history' });
    const afterEntries = (afterRes.json() as { entries: { id: number; addedTo: { marathonName: string }[] }[] }).entries;
    const entry = afterEntries.find(e => e.id === movieEntry.id)!;
    const names = entry.addedTo.map(a => a.marathonName).sort();
    assert.deepEqual(names, ['Second List', 'Watched Archive'], 'entry must show up in both lists it was promoted into');

    // And the "Watched Archive" list itself must still only have one item
    // for this entry (the earlier idempotent-reuse test didn't duplicate it).
    const marathonsRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    const watchedArchive = (marathonsRes.json() as { marathons: { id: number; name: string }[] }).marathons
      .find(m => m.name === 'Watched Archive')!;
    const itemsRes = await app.inject({ method: 'GET', url: `/api/marathons/${watchedArchive.id}` });
    const items = (itemsRes.json() as { items: { title: string }[] }).items;
    assert.equal(items.filter(i => i.title === 'Another Movie').length, 1, 'no duplicate item in the first list');
  });

  it('promoting into the same-named list again reuses it instead of duplicating', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entries = (listRes.json() as { entries: { id: number; title: string }[] }).entries;

    // Find an undismissed entry (if any remain after the previous test)
    // Create a new orphaned entry by scanning again
    await app.inject({ method: 'POST', url: '/api/history/scan' });
    const newListRes = await app.inject({ method: 'GET', url: '/api/history' });
    const newEntries = (newListRes.json() as { entries: { id: number; title: string }[] }).entries;

    // Use the movie entry if it's still available (not promoted yet removes it from history)
    // For this test, we'll promote a different history entry to the same marathon
    if (newEntries.length === 0) {
      // If no entries left, create another orphaned file to test with
      const fs = await import('fs');
      const { config } = await import('../src/config');
      const mediaDir = require('path').join(config.mediaDir, 'library');
      require('fs').mkdirSync(require('path').join(mediaDir, 'Third.Film.2020.hls'), { recursive: true });
      await app.inject({ method: 'POST', url: '/api/history/scan' });
    }

    const finalListRes = await app.inject({ method: 'GET', url: '/api/history' });
    const finalEntries = (finalListRes.json() as { entries: { id: number; title: string }[] }).entries;
    const testEntry = finalEntries[0];

    if (!testEntry) {
      throw new Error('No entries available to test promote reuse');
    }

    const promoteRes2 = await app.inject({
      method: 'POST', url: `/api/history/${testEntry.id}/promote`, payload: { marathonName: 'Watched Archive' },
    });
    assert.equal(promoteRes2.statusCode, 201);
    const body2 = promoteRes2.json() as { marathonId: number };

    // Verify the same marathon was reused (not duplicated)
    const marathonsRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    const marathons = (marathonsRes.json() as { marathons: { id: number; name: string }[] }).marathons;
    const watchedArchiveCount = marathons.filter(m => m.name === 'Watched Archive').length;
    assert.equal(watchedArchiveCount, 1, 'Watched Archive marathon must not be duplicated');
    assert.ok(marathons.some(m => m.id === body2.marathonId && m.name === 'Watched Archive'));
  });
});
