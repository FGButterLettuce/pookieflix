import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOld\n';
const SRT = '1\n00:00:05,000 --> 00:00:06,000\nNew\n';
const searchResponse = { data: [{ attributes: { files: [{ file_id: 7 }], ai_translated: false, machine_translated: false, movie_name: 'Film', release: 'WEB' } }] };

describe('subtitle routes', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let library: string;
  let film: string;
  let usedKeys: string[];
  let failDownload: boolean;
  const realFetch = globalThis.fetch;

  const api = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, payload });
  const pick = () => api('POST', '/api/library/film.mp4/subtitles', { fileId: 7, label: 'Film · WEB' });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-subs-test-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.OPENSUBTITLES_API_KEY;
    const Fastify = (await import('fastify')).default;
    const multipart = (await import('@fastify/multipart')).default;
    const { registerRoutes } = await import('../src/routes');
    const { config } = await import('../src/config');
    library = path.join(config.mediaDir, 'library');
    film = path.join(library, 'film.mp4');
    app = Fastify();
    await app.register(multipart);
    await registerRoutes(app);
    await api('POST', '/api/settings', { APP_BASE_URL: 'https://watch.example.com', OPENSUBTITLES_API_KEY: 'saved-key' });
  });

  beforeEach(() => {
    usedKeys = [];
    failDownload = false;
    fs.rmSync(library, { recursive: true, force: true });
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(film, 'film');
    fs.writeFileSync(`${film}.vtt`, VTT);
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const key = (init?.headers as Record<string, string> | undefined)?.['Api-Key'];
      if (key) usedKeys.push(key);
      if (url.includes('/subtitles?')) return Response.json(searchResponse);
      if (url.endsWith('/download')) return failDownload ? new Response('nope', { status: 429 }) : Response.json({ link: 'https://dl.example/file.srt' });
      if (url === 'https://dl.example/file.srt') return new Response(SRT);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses an OpenSubtitles key saved in Settings without a restart', async () => {
    const res = await api('GET', '/api/subtitle-search?q=film');
    assert.deepEqual(res.json().results, [{ fileId: 7, label: 'Film · WEB' }]);
    assert.deepEqual(usedKeys, ['saved-key']);
  });

  it('has the chosen subtitle on disk by the time the request returns', async () => {
    const res = await pick();
    assert.equal(res.statusCode, 200);
    assert.match(fs.readFileSync(`${film}.vtt`, 'utf8'), /00:00:05\.000 --> 00:00:06\.000\nNew/);
  });

  it('reports a failed download and keeps the current subtitle', async () => {
    failDownload = true;
    const res = await pick();
    assert.equal(res.statusCode, 502);
    assert.equal(fs.readFileSync(`${film}.vtt`, 'utf8'), VTT);
  });

  it('a newly chosen subtitle cannot be undone back to the old film\'s backup', async () => {
    await api('POST', '/api/library/film.mp4/subtitles/shift', { deltaMs: 500 });
    await pick();
    const undo = await api('POST', '/api/library/film.mp4/subtitles/sync/undo');
    assert.equal(undo.statusCode, 404);
  });

  it('deleting subtitles removes the undo backup', async () => {
    await api('POST', '/api/library/film.mp4/subtitles/shift', { deltaMs: 500 });
    await api('DELETE', '/api/library/film.mp4/subtitles');
    const undo = await api('POST', '/api/library/film.mp4/subtitles/sync/undo');
    assert.equal(undo.statusCode, 404);
    assert.equal(fs.existsSync(`${film}.vtt`), false);
  });

  it('deleting the film removes the undo backup', async () => {
    await api('POST', '/api/library/film.mp4/subtitles/shift', { deltaMs: 500 });
    await api('DELETE', '/api/library/film.mp4');
    assert.equal(fs.existsSync(`${film}.vtt.presync.bak`), false);
  });

  it('undo still works after the film is renamed', async () => {
    await api('POST', '/api/library/film.mp4/subtitles/shift', { deltaMs: 500 });
    await api('PATCH', '/api/library/film.mp4', { newFilename: 'renamed.mp4' });
    const undo = await api('POST', '/api/library/renamed.mp4/subtitles/sync/undo');
    assert.equal(undo.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(library, 'renamed.mp4.vtt'), 'utf8'), VTT);
  });
});
