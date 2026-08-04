import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('library file poster', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let libraryDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-library-poster-test-'));
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

  it('setting a poster persists and is exposed via GET /api/library', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/library/Thor.mp4',
      payload: { posterPath: '/abc123.jpg', tmdbId: 10195 },
    });
    assert.equal(patchRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/library' });
    const file = (listRes.json() as { files: Array<{ filename: string; posterPath: string | null }> })
      .files.find(f => f.filename === 'Thor.mp4');
    assert.equal(file?.posterPath, '/abc123.jpg');
  });

  it('renaming a file with a poster carries the poster to the new filename', async () => {
    const renameRes = await app.inject({
      method: 'PATCH',
      url: '/api/library/Thor.mp4',
      payload: { newFilename: 'Thor 2011.mp4' },
    });
    assert.equal(renameRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/library' });
    const file = (listRes.json() as { files: Array<{ filename: string; posterPath: string | null }> })
      .files.find(f => f.filename === 'Thor 2011.mp4');
    assert.equal(file?.posterPath, '/abc123.jpg', 'poster must survive the rename, not just the video file');
  });
});
