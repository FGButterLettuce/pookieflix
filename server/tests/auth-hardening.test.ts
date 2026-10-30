import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('auth hardening', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let configPath: string;
  let hashPassword: (p: string) => string;
  const publicVisitor = { 'cf-connecting-ip': '198.51.100.7' };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-hardening-test-'));
    process.env.DATA_DIR = dataDir;
    configPath = path.join(dataDir, 'config.json');
    const Fastify = (await import('fastify')).default;
    const rateLimit = (await import('@fastify/rate-limit')).default;
    const { registerRoutes } = await import('../src/routes');
    const { rateLimitKey } = await import('../src/clientIp');
    ({ hashPassword } = await import('../src/auth'));
    app = Fastify();
    await app.register(rateLimit, { global: true, max: 200, timeWindow: '1m', keyGenerator: rateLimitKey });
    await registerRoutes(app);
  });

  beforeEach(() => {
    fs.rmSync(configPath, { force: true });
    for (const key of ['PASSWORD_HASH', 'SESSION_SECRET', 'APP_BASE_URL']) delete process.env[key];
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects admin routes from a public visitor before a password exists', async () => {
    const library = await app.inject({ method: 'GET', url: '/api/library', headers: publicVisitor });
    assert.equal(library.statusCode, 403);
    const claim = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: publicVisitor, payload: { newPassword: 'attacker1' } });
    assert.equal(claim.statusCode, 403);
    assert.equal(fs.existsSync(configPath), false);
  });

  it('rejects a public peer that connects directly before a password exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/library', remoteAddress: '203.0.113.9' });
    assert.equal(res.statusCode, 403);
  });

  it('keeps first-run setup available on the LAN', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/library', remoteAddress: '192.168.0.20' });
    assert.equal(res.statusCode, 200);
  });

  it('reports a public visitor as signed out before a password exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: publicVisitor });
    assert.deepEqual(res.json(), { authed: false });
  });

  it('keeps setup incomplete until a password exists, even with APP_BASE_URL set', async () => {
    process.env.APP_BASE_URL = 'https://watch.example.com';
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(res.json().setupComplete, false);
  });

  it('a blank PASSWORD_HASH env var does not disable the saved password', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ PASSWORD_HASH: hashPassword('secret1'), SESSION_SECRET: 's'.repeat(64) }));
    process.env.PASSWORD_HASH = '';
    process.env.SESSION_SECRET = '';
    const res = await app.inject({ method: 'GET', url: '/api/library' });
    assert.equal(res.statusCode, 401);
  });

  it('refuses a password change the env-managed hash would ignore', async () => {
    process.env.PASSWORD_HASH = hashPassword('secret1');
    process.env.SESSION_SECRET = 's'.repeat(64);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const res = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { cookie }, payload: { newPassword: 'another1' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('stops a corrupt config file from disabling auth', async () => {
    fs.writeFileSync(configPath, '{"PASSWORD_HASH": "trunc');
    const res = await app.inject({ method: 'GET', url: '/api/library' });
    assert.equal(res.statusCode, 500);
  });

  it('writes secrets owner-only with no temp file left behind', async () => {
    const { writePersistedConfig } = await import('../src/persistedConfig');
    writePersistedConfig({ TMDB_API_KEY: 'k' });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dataDir).filter(f => f.startsWith('config.json')), ['config.json']);
  });

  it('limits password guesses even when the forwarded chain is rotated', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ PASSWORD_HASH: hashPassword('secret1'), SESSION_SECRET: 's'.repeat(64) }));
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': `10.0.0.${i}, 198.51.100.8` },
        payload: { password: 'wrong' },
      });
      codes.push(res.statusCode);
    }
    assert.equal(codes[9], 401);
    assert.equal(codes[10], 429);
  });
});
