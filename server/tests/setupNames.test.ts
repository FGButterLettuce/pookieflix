import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('user/partner name persistence', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-names-test-'));
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

  it('persists USER_NAME and PARTNER_NAME through /api/setup and returns them from /api/settings', async () => {
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        APP_BASE_URL: 'https://watch.example.com',
        USER_NAME: 'Niranjan',
        PARTNER_NAME: 'Anu',
      },
    });
    assert.equal(setupRes.statusCode, 200);

    const settingsRes = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = settingsRes.json() as { USER_NAME: string; PARTNER_NAME: string };
    assert.equal(body.USER_NAME, 'Niranjan');
    assert.equal(body.PARTNER_NAME, 'Anu');
  });

  it('updates names via /api/settings without needing APP_BASE_URL to change', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: { APP_BASE_URL: 'https://watch.example.com', USER_NAME: 'Nira', PARTNER_NAME: 'Anushka' },
    });
    const settingsRes = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = settingsRes.json() as { USER_NAME: string; PARTNER_NAME: string };
    assert.equal(body.USER_NAME, 'Nira');
    assert.equal(body.PARTNER_NAME, 'Anushka');
  });
});
