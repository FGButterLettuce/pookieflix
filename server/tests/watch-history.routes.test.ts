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

  it('promotes a history entry into a new list', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/history' });
    const entries = (listRes.json() as { entries: { id: number; title: string }[] }).entries;
    const movieEntry = entries.find(e => e.title === 'Another Movie')!;

    const promoteRes = await app.inject({
      method: 'POST', url: `/api/history/${movieEntry.id}/promote`, payload: { marathonName: 'Watched Archive' },
    });
    assert.equal(promoteRes.statusCode, 201);
    const body = promoteRes.json() as { item: { title: string }; marathonId: number };
    assert.equal(body.item.title, 'Another Movie');

    const marathonsRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    const marathons = (marathonsRes.json() as { marathons: { id: number; name: string }[] }).marathons;
    assert.ok(marathons.some(m => m.id === body.marathonId && m.name === 'Watched Archive'));

    // Promotion must dismiss the history entry server-side, so it's gone on
    // reload — not just hidden behind local-only React state that a page
    // refresh would forget, which is what let a repeat promote after reload
    // create a duplicate list item.
    const afterPromoteRes = await app.inject({ method: 'GET', url: '/api/history' });
    const afterPromoteEntries = (afterPromoteRes.json() as { entries: { id: number }[] }).entries;
    assert.ok(!afterPromoteEntries.some(e => e.id === movieEntry.id), 'promoted entry must be dismissed, not just left for the client to remember');

    // A repeat promote attempt on the now-dismissed entry must not create a
    // second item — since listWatchHistory only returns non-dismissed rows,
    // it 404s instead of duplicating.
    const repeatRes = await app.inject({
      method: 'POST', url: `/api/history/${movieEntry.id}/promote`, payload: { marathonName: 'Watched Archive' },
    });
    assert.equal(repeatRes.statusCode, 404);
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
