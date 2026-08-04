import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('watch session logging', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let libraryDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-watch-sessions-test-'));
    process.env.DATA_DIR = dataDir;
    const { config } = await import('../src/config');
    libraryDir = path.join(config.mediaDir, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'Thor.mp4'), 'fake video bytes');

    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creating a room from a library file logs a durable watch session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { filename: 'Thor.mp4' } });
    assert.equal(res.statusCode, 201);

    const { getWatchSessionStats } = await import('../src/db');
    const stats = getWatchSessionStats('Thor.mp4');
    assert.equal(stats.count, 1);
    assert.ok(stats.firstAt);
    assert.equal(stats.firstAt, stats.lastAt);
  });

  it('a second room for the same file increments the count and moves lastAt', async () => {
    const before = (await import('../src/db')).getWatchSessionStats('Thor.mp4');

    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { filename: 'Thor.mp4' } });
    assert.equal(res.statusCode, 201);

    const { getWatchSessionStats } = await import('../src/db');
    const stats = getWatchSessionStats('Thor.mp4');
    assert.equal(stats.count, 2);
    assert.equal(stats.firstAt, before.firstAt, 'first session timestamp must not change');
  });

  it('a file that was never watched has zero sessions', async () => {
    const { getWatchSessionStats } = await import('../src/db');
    const stats = getWatchSessionStats('Never.Watched.mp4');
    assert.deepEqual(stats, { count: 0, firstAt: null, lastAt: null });
  });
});
