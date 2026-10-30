import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';

describe('faststart', () => {
  let dataDir: string;
  let library: string;
  let app: FastifyInstance;
  let ffmpeg: typeof import('../src/ffmpeg');

  const makeVideo = (file: string) => {
    spawnSync('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-c:v', 'libx264', '-y', file]);
    assert.ok(fs.existsSync(file), 'fixture failed to generate — is ffmpeg installed?');
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-faststart-test-'));
    process.env.DATA_DIR = dataDir;
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes');
    const { config } = await import('../src/config');
    ffmpeg = await import('../src/ffmpeg');
    library = path.join(config.mediaDir, 'library');
    fs.mkdirSync(library, { recursive: true });
    app = Fastify();
    await registerRoutes(app);
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('moves the moov atom ahead of the media data', async () => {
    const file = path.join(library, 'moov.mp4');
    makeVideo(file);
    const atoms = () => { const b = fs.readFileSync(file); return { moov: b.indexOf('moov'), mdat: b.indexOf('mdat') }; };
    assert.ok(atoms().moov > atoms().mdat, 'fixture must start with moov at the end');
    await ffmpeg.applyFastStart(file);
    assert.ok(atoms().moov < atoms().mdat);
    assert.deepEqual(fs.readdirSync(library).filter(f => f.endsWith('.tmp')), []);
  });

  it('leaves an unreadable file untouched', async () => {
    const file = path.join(library, 'junk.mp4');
    fs.writeFileSync(file, 'not a video');
    await ffmpeg.applyFastStart(file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a video');
    assert.deepEqual(fs.readdirSync(library).filter(f => f.endsWith('.tmp')), []);
  });

  it('does not rewrite the film under active viewers when a room is created', async () => {
    const file = path.join(library, 'room.mp4');
    makeVideo(file);
    const inode = fs.statSync(file).ino;
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { filename: 'room.mp4' } });
    assert.equal(res.statusCode, 201);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(fs.statSync(file).ino, inode);
  });
});
