import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('tmdb search route', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-tmdb-test-'));
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

  it('returns 503 with no TMDB_API_KEY configured, rather than crashing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmdb/search?query=Thor' });
    assert.equal(res.statusCode, 503);
    assert.match((res.json() as { error: string }).error, /TMDB/);
  });

  it('rejects an empty query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tmdb/search?query=' });
    assert.equal(res.statusCode, 400);
  });
});
