import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

interface LogRow { device: string; level: string; msg: string; ts: number }

describe('POST /api/debug/logs', () => {
  let app: FastifyInstance;
  let dataDir: string;
  const logs = async (): Promise<LogRow[]> => (await app.inject({
    method: 'GET', url: '/api/internal/diagnostics/live?limit=1000', headers: { authorization: 'Bearer test-token' },
  })).json().logs;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-logs-test-'));
    process.env.DATA_DIR = dataDir;
    process.env.DIAGNOSTICS_TOKEN = 'test-token';
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores a normal client batch', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/debug/logs', payload: { device: 'DSK-A', entries: [{ ts: 1000, level: 'warn', msg: 'hello' }] } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((await logs()).at(-1), { ts: 1000, device: 'DSK-A', level: 'warn', msg: 'hello' });
  });

  it('collapses an oversized level instead of storing it', async () => {
    await app.inject({ method: 'POST', url: '/api/debug/logs', payload: { device: 'DSK-B', entries: [{ ts: 2000, level: 'x'.repeat(50_000), msg: 'm' }] } });
    assert.equal((await logs()).at(-1)?.level, 'log');
  });

  it('caps the number of entries stored from one request', async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({ ts: 3000 + i, level: 'log', msg: 'x' }));
    await app.inject({ method: 'POST', url: '/api/debug/logs', payload: { device: 'DSK-C', entries } });
    assert.equal((await logs()).filter(l => l.device === 'DSK-C').length, 100);
  });

  it('rejects a body far larger than a client batch', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/debug/logs', payload: { device: 'DSK-D', entries: [{ ts: 1, level: 'log', msg: 'y'.repeat(200_000) }] } });
    assert.equal(res.statusCode, 413);
  });

  it('ignores a non-array entries value', async () => {
    const before = (await logs()).length;
    const res = await app.inject({ method: 'POST', url: '/api/debug/logs', payload: { device: 'DSK-E', entries: 42 } });
    assert.equal(res.statusCode, 200);
    assert.equal((await logs()).length, before);
  });
});
