import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

const BOUNDARY = 'pookie-boundary';
const head = (name: string) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="video"; filename="${name}"\r\nContent-Type: video/mp4\r\n\r\n`;
const form = (name: string, bytes: string) => `${head(name)}${bytes}\r\n--${BOUNDARY}--\r\n`;

describe('POST /api/upload', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let library: string;
  let film: string;

  const upload = (payload: string) => app.inject({
    method: 'POST',
    url: '/api/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
  const leftovers = () => fs.readdirSync(library).filter(f => f.includes('.upload-'));

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-upload-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.MAX_UPLOAD_BYTES = '1000';
    const Fastify = (await import('fastify')).default;
    const multipart = (await import('@fastify/multipart')).default;
    const { registerRoutes } = await import('../src/routes');
    const { config } = await import('../src/config');
    library = path.join(config.mediaDir, 'library');
    film = path.join(library, 'film.mp4');
    app = Fastify();
    await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
    await registerRoutes(app);
  });

  beforeEach(() => {
    fs.rmSync(library, { recursive: true, force: true });
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(film, 'original film');
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the existing film when a same-name upload is too large', async () => {
    const res = await upload(form('film.mp4', 'x'.repeat(5000)));
    assert.equal(res.statusCode, 413);
    assert.equal(fs.readFileSync(film, 'utf8'), 'original film');
    assert.deepEqual(leftovers(), []);
  });

  it('keeps the existing film when a same-name upload is cut off', async () => {
    const res = await upload(`${head('film.mp4')}partial bytes`);
    assert.ok(res.statusCode >= 400, `status ${res.statusCode}`);
    assert.equal(fs.readFileSync(film, 'utf8'), 'original film');
    assert.deepEqual(leftovers(), []);
  });

  it('replaces the film and every file derived from the old version', async () => {
    const hls = path.join(library, 'film.hls');
    fs.mkdirSync(hls);
    fs.writeFileSync(path.join(hls, 'seg0000.ts'), 'old segment');
    fs.writeFileSync(path.join(hls, 'index.m3u8'), '#EXTM3U');
    fs.writeFileSync(`${film}.vtt`, 'WEBVTT\n\nold');
    fs.writeFileSync(`${film}.vtt.presync.bak`, 'WEBVTT\n\nolder');
    const res = await upload(form('film.mp4', 'new film'));
    assert.equal(res.statusCode, 201);
    assert.equal(fs.readFileSync(film, 'utf8'), 'new film');
    assert.equal(fs.existsSync(path.join(hls, 'seg0000.ts')), false);
    assert.equal(fs.existsSync(`${film}.vtt`), false);
    assert.equal(fs.existsSync(`${film}.vtt.presync.bak`), false);
    assert.deepEqual(leftovers(), []);
  });

  it('does not reuse a stale transcode left by a deleted film of the same name', async () => {
    fs.rmSync(film);
    const hls = path.join(library, 'film.hls');
    fs.mkdirSync(hls);
    fs.writeFileSync(path.join(hls, 'seg0000.ts'), 'stale');
    const res = await upload(form('film.mp4', 'different film'));
    assert.equal(res.statusCode, 201);
    assert.equal(fs.existsSync(path.join(hls, 'seg0000.ts')), false);
  });
});
