import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

// No password is configured in the fresh temp DATA_DIR used by these tests,
// so requireAdmin() passes every request through open (see its early
// `if (!getPasswordHash()) return;` in server/src/routes.ts) — no login/cookie
// dance needed here. Auth enforcement itself is already covered by auth.test.ts.
describe('marathons routes', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathons-routes-test-'));
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

  it('creates and lists a marathon', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Avengers Marathon' } });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json() as { marathon: { id: number; name: string } };
    assert.equal(created.marathon.name, 'Avengers Marathon');

    const listRes = await app.inject({ method: 'GET', url: '/api/marathons' });
    assert.equal(listRes.statusCode, 200);
    const list = listRes.json() as { marathons: { id: number; name: string }[] };
    assert.ok(list.marathons.some(m => m.id === created.marathon.id));
  });

  it('rejects creating a marathon with an empty name', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: '   ' } });
    assert.equal(res.statusCode, 400);
  });

  it('renames and deletes a marathon', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/marathons', payload: { name: 'Temp' } });
    const { marathon } = createRes.json() as { marathon: { id: number } };

    const renameRes = await app.inject({ method: 'PATCH', url: `/api/marathons/${marathon.id}`, payload: { name: 'Renamed' } });
    assert.equal(renameRes.statusCode, 200);

    const getRes = await app.inject({ method: 'GET', url: `/api/marathons/${marathon.id}` });
    assert.equal((getRes.json() as { name: string }).name, 'Renamed');

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/marathons/${marathon.id}` });
    assert.equal(deleteRes.statusCode, 200);

    const afterDelete = await app.inject({ method: 'GET', url: `/api/marathons/${marathon.id}` });
    assert.equal(afterDelete.statusCode, 404);
  });

  it('404s renaming/deleting a marathon that does not exist', async () => {
    const renameRes = await app.inject({ method: 'PATCH', url: '/api/marathons/999999', payload: { name: 'X' } });
    assert.equal(renameRes.statusCode, 404);
    const deleteRes = await app.inject({ method: 'DELETE', url: '/api/marathons/999999' });
    assert.equal(deleteRes.statusCode, 404);
  });
});
