import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('library file rename', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let libraryDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-library-rename-test-'));
    process.env.DATA_DIR = dataDir;
    const { config } = await import('../src/config');
    libraryDir = path.join(config.mediaDir, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });

    // A tracked file plus its HLS transcode cache dir, exactly what the
    // rename route is expected to move together.
    fs.writeFileSync(path.join(libraryDir, 'Thor.mp4'), 'fake video bytes');
    fs.mkdirSync(path.join(libraryDir, 'Thor.hls'));
    fs.writeFileSync(path.join(libraryDir, 'Thor.hls', 'index.m3u8'), '#EXTM3U');

    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('renames the .hls cache dir alongside the video file, so a rename never orphans it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/library/Thor.mp4',
      payload: { newFilename: 'Thor 2011.mp4' },
    });
    assert.equal(res.statusCode, 200);

    assert.ok(fs.existsSync(path.join(libraryDir, 'Thor 2011.mp4')), 'renamed video file should exist');
    assert.ok(!fs.existsSync(path.join(libraryDir, 'Thor.mp4')), 'old video filename should be gone');

    assert.ok(fs.existsSync(path.join(libraryDir, 'Thor 2011.hls')), 'HLS dir must move to the new name');
    assert.ok(!fs.existsSync(path.join(libraryDir, 'Thor.hls')), 'old HLS dir must not be left behind (would be misread as watch history)');
  });

  it('the watch-history orphan scan finds nothing after the rename', async () => {
    const scanRes = await app.inject({ method: 'POST', url: '/api/history/scan' });
    assert.equal(scanRes.statusCode, 200);
    assert.equal((scanRes.json() as { found: number }).found, 0, 'renamed-but-still-present file must not show up as watch history');
  });
});
