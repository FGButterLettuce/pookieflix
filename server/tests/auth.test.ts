import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('live password auth (no restart required)', () => {
  let app: FastifyInstance;
  let dataDir: string;

  before(async () => {
    // DATA_DIR must be set before config.ts/persistedConfig.ts are ever
    // imported in this process (Node's test runner gives each test file its
    // own process, but static imports are hoisted above any top-level
    // assignment) - so the modules under test are loaded dynamically here,
    // after the override is in place.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-auth-test-'));
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

  it('is open (authed=true) before any password is set', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.json().authed, true);
  });

  it('setting a password via change-password takes effect immediately, without a restart', async () => {
    const changeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { newPassword: 'correct horse battery staple' },
    });
    assert.equal(changeRes.statusCode, 200);

    // No cookie sent - this is the exact regression the frozen `config`
    // object caused: it would still report authed=true here forever,
    // since config.passwordHash was cached empty at server boot.
    const meRes = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(meRes.json().authed, false);
  });

  it('a protected route now requires a valid session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(res.statusCode, 401);
  });

  it('logging in with the new password grants access to protected routes', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'correct horse battery staple' },
    });
    assert.equal(loginRes.statusCode, 200);
    const cookie = loginRes.cookies.find(c => c.name === 'wt_session');
    assert.ok(cookie, 'expected a wt_session cookie to be set on login');

    const settingsRes = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { wt_session: cookie!.value },
    });
    assert.equal(settingsRes.statusCode, 200);
  });
});
