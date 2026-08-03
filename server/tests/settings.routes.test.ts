import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('settings masked-key round-trip', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let readPersistedConfig: () => { TMDB_API_KEY?: string; OPENSUBTITLES_API_KEY?: string };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-settings-test-'));
    process.env.DATA_DIR = dataDir;

    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    ({ readPersistedConfig } = await import('../src/persistedConfig'));

    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists a real TMDB_API_KEY and OPENSUBTITLES_API_KEY on first save', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        APP_BASE_URL: 'https://watch.example.com',
        TMDB_API_KEY: 'real-tmdb-key-123',
        OPENSUBTITLES_API_KEY: 'real-os-key-456',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(readPersistedConfig().TMDB_API_KEY, 'real-tmdb-key-123');
    assert.equal(readPersistedConfig().OPENSUBTITLES_API_KEY, 'real-os-key-456');
  });

  it('GET /api/settings masks both configured keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = res.json() as { TMDB_API_KEY: string; OPENSUBTITLES_API_KEY: string };
    assert.equal(body.TMDB_API_KEY, '••••••••');
    assert.equal(body.OPENSUBTITLES_API_KEY, '••••••••');
  });

  it('re-saving with the masked placeholder (as the client round-trips it) does not clobber the real keys', async () => {
    // Simulates exactly what Settings.tsx does today: it spreads the whole
    // `values` object — including whatever GET last returned for the masked
    // fields — back into the POST body when saving an unrelated field.
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        APP_BASE_URL: 'https://watch.example.com',
        LAN_URL: 'http://192.168.0.91:3000',
        TMDB_API_KEY: '••••••••',
        OPENSUBTITLES_API_KEY: '••••••••',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(readPersistedConfig().TMDB_API_KEY, 'real-tmdb-key-123', 'TMDB key must survive an unrelated save');
    assert.equal(readPersistedConfig().OPENSUBTITLES_API_KEY, 'real-os-key-456', 'OpenSubtitles key must survive an unrelated save');
  });

  it('saving a genuinely new key value still updates it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        APP_BASE_URL: 'https://watch.example.com',
        TMDB_API_KEY: 'rotated-tmdb-key-789',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(readPersistedConfig().TMDB_API_KEY, 'rotated-tmdb-key-789');
    // Untouched sibling key from the previous test must still be intact.
    assert.equal(readPersistedConfig().OPENSUBTITLES_API_KEY, 'real-os-key-456');
  });

  it('saving a blank key is a no-op (does not clear an already-configured key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        APP_BASE_URL: 'https://watch.example.com',
        TMDB_API_KEY: '',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(readPersistedConfig().TMDB_API_KEY, 'rotated-tmdb-key-789');
  });
});
