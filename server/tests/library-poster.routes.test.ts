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

  it('setting a poster and displayTitle persists and is exposed via GET /api/library', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/library/Thor.mp4',
      payload: { posterPath: '/abc123.jpg', tmdbId: 10195, displayTitle: 'Thor' },
    });
    assert.equal(patchRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/library' });
    const file = (listRes.json() as { files: Array<{ filename: string; posterPath: string | null; displayTitle: string | null }> })
      .files.find(f => f.filename === 'Thor.mp4');
    assert.equal(file?.posterPath, '/abc123.jpg');
    assert.equal(file?.displayTitle, 'Thor');
  });

  it('a later poster-only update (no displayTitle in the payload) does not blank the existing displayTitle', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/library/Thor.mp4',
      payload: { posterPath: '/xyz789.jpg', tmdbId: 10195 },
    });
    assert.equal(patchRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/library' });
    const file = (listRes.json() as { files: Array<{ filename: string; posterPath: string | null; displayTitle: string | null }> })
      .files.find(f => f.filename === 'Thor.mp4');
    assert.equal(file?.posterPath, '/xyz789.jpg', 'poster itself should still update');
    assert.equal(file?.displayTitle, 'Thor', 'displayTitle must survive an update that does not mention it');
  });

  it('renaming a file with a poster and displayTitle carries both to the new filename', async () => {
    const renameRes = await app.inject({
      method: 'PATCH',
      url: '/api/library/Thor.mp4',
      payload: { newFilename: 'Thor 2011.mp4' },
    });
    assert.equal(renameRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/library' });
    const file = (listRes.json() as { files: Array<{ filename: string; posterPath: string | null; displayTitle: string | null }> })
      .files.find(f => f.filename === 'Thor 2011.mp4');
    assert.equal(file?.posterPath, '/xyz789.jpg', 'poster must survive the rename, not just the video file');
    assert.equal(file?.displayTitle, 'Thor', 'displayTitle must survive the rename too');
  });
});
