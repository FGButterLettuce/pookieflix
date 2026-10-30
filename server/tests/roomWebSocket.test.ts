import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';

const TOKEN = 'a'.repeat(64);
interface Msg { type: string; [k: string]: unknown }

// Real sockets through the real server wiring: exceptions in a ws 'message'
// listener are uncaught, so these fail the whole process if validation regresses.
describe('room WebSocket layer', () => {
  let dataDir: string;
  let videoPath: string;
  let wss: WebSocketServer;
  let port: number;
  let roomManager: typeof import('../src/roomManager');
  let open: WebSocket[] = [];

  const connect = (): Promise<{ ws: WebSocket; messages: Msg[] }> => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?roomToken=${TOKEN}`);
    const messages: Msg[] = [];
    open.push(ws);
    ws.on('message', d => messages.push(JSON.parse(d.toString()) as Msg));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });

  const waitFor = async (check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
      await new Promise(r => setTimeout(r, 5));
    }
  };

  const runtime = () => roomManager.getRuntimeByToken(TOKEN)!;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-ws-test-'));
    process.env.DATA_DIR = dataDir;
    const db = await import('../src/db');
    roomManager = await import('../src/roomManager');
    const library = path.join(dataDir, 'media', 'library');
    fs.mkdirSync(library, { recursive: true });
    videoPath = path.join(library, 'film.mp4');
    db.createRoom({
      id: 'room', token: TOKEN, media_path: videoPath, media_filename: 'film.mp4',
      media_size: 1, created_at: Date.now(), expires_at: Date.now() + 3_600_000,
    });
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(r => wss.once('listening', r));
    port = (wss.address() as AddressInfo).port;
    roomManager.setupWebSocketServer(wss);
  });

  afterEach(async () => {
    open.forEach(ws => ws.terminate());
    open = [];
    await waitFor(() => roomManager.getRuntimeByToken(TOKEN) === null, 'room teardown');
  });

  after(async () => {
    await new Promise(r => wss.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const malformed = [
    'null', '42', '[]', '"text"', 'not json',
    '{"type":"USER_ACTION"}',
    '{"type":"USER_ACTION","data":null}',
    '{"type":"USER_ACTION","data":{"action":"DANCE"}}',
    '{"type":"USER_ACTION","data":{"action":"SEEK","mediaTime":"soon"}}',
    '{"type":"USER_ACTION","data":{"action":"SEEK","mediaTime":-1}}',
    '{"type":"USER_ACTION","data":{"action":"SEEK"}}',
    '{"type":"HEARTBEAT"}',
    '{"type":"HEARTBEAT","data":{"mediaTime":"x"}}',
    '{"type":"SET_SINGLE_PLAYER","enabled":"yes"}',
  ];

  for (const raw of malformed) {
    it(`ignores ${raw}`, async () => {
      const { ws, messages } = await connect();
      await waitFor(() => messages.some(m => m.type === 'JOINED'), 'JOINED');
      ws.send(raw);
      ws.send('{"type":"SET_SINGLE_PLAYER","enabled":true}');
      await waitFor(() => runtime().singlePlayer === true, 'valid message after malformed one');
      assert.equal(runtime().canonicalTime, 0);
      assert.equal(Array.from(runtime().viewers.values())[0].heartbeat, null);
      assert.equal(runtime().state === 'SEEKING', false);
    });
  }

  it('accepts a complete heartbeat with the playback-blocked flag', async () => {
    const { ws, messages } = await connect();
    await waitFor(() => messages.some(m => m.type === 'JOINED'), 'JOINED');
    ws.send(JSON.stringify({ type: 'HEARTBEAT', data: {
      mediaTime: 12.5, paused: true, ended: false, seeking: false, waiting: false, readyState: 4,
      bufferedAhead: 20, playbackRate: 1, lastUserAction: 0, serverCommandPending: false, playbackBlocked: true,
    } }));
    await waitFor(() => Array.from(runtime().viewers.values())[0].heartbeat !== null, 'heartbeat');
    assert.equal(Array.from(runtime().viewers.values())[0].heartbeat?.playbackBlocked, true);
  });

  it('evicting a stale viewer pauses the room and remembers a user pause', async () => {
    const first = await connect();
    await waitFor(() => first.messages.some(m => m.type === 'JOINED'), 'first JOINED');
    const second = await connect();
    await waitFor(() => second.messages.some(m => m.type === 'JOINED'), 'second JOINED');
    const room = runtime();
    room.state = 'USER_PAUSED';
    const [stale] = room.viewers.values();
    stale.heartbeatAt = Date.now() - 5000;

    const third = await connect();
    await waitFor(() => third.messages.some(m => m.type === 'JOINED'), 'third JOINED');

    assert.equal(room.viewers.size, 2);
    assert.equal(room.state, 'WAITING_FOR_VIEWERS');
    assert.equal(room.wasUserPaused, true);
    await waitFor(() => first.ws.readyState === WebSocket.CLOSED, 'evicted socket close');
    assert.equal(room.wasUserPaused, true);
    assert.equal(room.viewers.size, 2);
  });

  describe('subtitle updates', () => {
    beforeEach(() => fs.rmSync(`${videoPath}.vtt`, { force: true }));

    it('tells every viewer about a new subtitle file with a cache-busted URL', async () => {
      const a = await connect();
      const b = await connect();
      await waitFor(() => a.messages.some(m => m.type === 'JOINED') && b.messages.some(m => m.type === 'JOINED'), 'both JOINED');
      fs.writeFileSync(`${videoPath}.vtt`, 'WEBVTT\n');
      roomManager.notifySubtitlesChanged('film.mp4');
      for (const viewer of [a, b]) {
        await waitFor(() => viewer.messages.some(m => m.type === 'SUBTITLES_CHANGED'), 'SUBTITLES_CHANGED');
        const msg = viewer.messages.find(m => m.type === 'SUBTITLES_CHANGED')!;
        assert.match(String(msg.subtitleUrl), new RegExp(`^/api/subtitle/${TOKEN}\\?v=\\d+$`));
      }
    });

    it('clears the URL when the subtitle file is gone', async () => {
      const a = await connect();
      await waitFor(() => a.messages.some(m => m.type === 'JOINED'), 'JOINED');
      roomManager.notifySubtitlesChanged('film.mp4');
      await waitFor(() => a.messages.some(m => m.type === 'SUBTITLES_CHANGED'), 'SUBTITLES_CHANGED');
      assert.equal(a.messages.find(m => m.type === 'SUBTITLES_CHANGED')!.subtitleUrl, undefined);
    });

    it('does not message rooms watching a different film', async () => {
      const a = await connect();
      await waitFor(() => a.messages.some(m => m.type === 'JOINED'), 'JOINED');
      roomManager.notifySubtitlesChanged('other.mp4');
      await new Promise(r => setTimeout(r, 30));
      assert.equal(a.messages.some(m => m.type === 'SUBTITLES_CHANGED'), false);
    });
  });
});
