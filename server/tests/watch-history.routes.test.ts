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
