import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import net, { type AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';

const freePort = (): Promise<number> => new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});

// A real process, because the thing under test is whether it actually exits.
describe('graceful shutdown', () => {
  let server: ChildProcess;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  const start = async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-shutdown-test-'));
    fs.mkdirSync(path.join(dataDir, 'media', 'library'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'media', 'library', 'film.mp4'), 'not really a film');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
      stdio: 'ignore',
      detached: true,
    });
    for (let i = 0; ; i++) {
      try { await fetch(`${base}/api/config`); return; } catch {
        if (i > 150) assert.fail('server never started');
        await new Promise(r => setTimeout(r, 100));
      }
    }
  };

  const exitsAfterSigterm = (): Promise<boolean> => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 4000);
    server.once('exit', () => { clearTimeout(timer); resolve(true); });
    process.kill(-server.pid!, 'SIGTERM');
  });

  before(() => { assert.ok(fs.existsSync('src/index.ts'), 'run from the server directory'); });

  afterEach(() => {
    try { process.kill(-server.pid!, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('exits promptly with a viewer connected', async () => {
    await start();
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'film.mp4' }),
    });
    const { roomToken } = await res.json() as { roomToken: string };
    const ws = new WebSocket(`${wsBase}/ws?roomToken=${roomToken}`);
    await new Promise(resolve => ws.once('message', resolve));
    assert.equal(await exitsAfterSigterm(), true);
    ws.terminate();
  });

  it('exits promptly with the live log stream open', async () => {
    await start();
    await new Promise<void>(resolve => {
      http.get(`${base}/api/debug/logs/stream`, res => { res.once('data', () => resolve()); });
      fetch(`${base}/api/debug/logs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device: 'x', entries: [{ ts: 1, level: 'log', msg: 'hi' }] }),
      }).catch(() => {});
    });
    assert.equal(await exitsAfterSigterm(), true);
  });
});
