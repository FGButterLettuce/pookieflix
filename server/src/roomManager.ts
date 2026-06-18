import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config';
import { getRoomByToken, updateLibraryLastTime, getLibraryMeta } from './db';
import { hasSubtitles } from './subtitles';
import { hasHLS } from './ffmpeg';
import path from 'path';
import { tick, handleUserAction, handleViewerDisconnect } from './roomStateMachine';
import type {
  RoomRuntime,
  ViewerRuntime,
  ClientMessage,
  ServerMessage,
} from './types';
import type { DispatchItem } from './roomStateMachine';

const rooms = new Map<string, RoomRuntime>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

// ── Room lifecycle ────────────────────────────────────────────────────────────

export function getOrCreateRuntime(token: string): RoomRuntime | null {
  if (rooms.has(token)) return rooms.get(token)!;

  const row = getRoomByToken(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) return null;

  const runtime: RoomRuntime = {
    roomId: row.id,
    roomToken: row.token,
    mediaPath: row.media_path,
    mediaFilename: row.media_filename,
    mediaSize: row.media_size,
    expiresAt: row.expires_at,
    state: 'WAITING_FOR_VIEWERS',
    viewers: new Map(),
    canonicalTime: getLibraryMeta(row.media_filename)?.last_time ?? 0,
    canonicalTimeUpdatedAt: Date.now(),
    wasPlayingBeforeInterruption: false,
    wasUserPaused: false,
    pendingRateTarget: new Map(),
    lastTickAt: Date.now(),
  };

  rooms.set(token, runtime);
  return runtime;
}

export function getRuntimeByToken(token: string): RoomRuntime | null {
  return rooms.get(token) ?? null;
}

// ── Viewer management ─────────────────────────────────────────────────────────

function generateViewerId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function persistLastTime(room: RoomRuntime): void {
  if (room.canonicalTime <= 0) return;
  const libraryDir = path.join(config.mediaDir, 'library');
  if (!room.mediaPath.startsWith(libraryDir)) return;
  try { updateLibraryLastTime(room.mediaFilename, room.canonicalTime); } catch { /* ignore */ }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch { /* ignore */ }
}

function dispatch(room: RoomRuntime, items: DispatchItem[]): void {
  for (const item of items) {
    if (item.viewerId === 'ALL') {
      for (const v of room.viewers.values()) send(v.ws, item.message);
    } else {
      const viewer = room.viewers.get(item.viewerId);
      if (viewer) send(viewer.ws, item.message);
    }
  }
}

export function joinRoom(token: string, ws: WebSocket): string | null {
  const room = getOrCreateRuntime(token);
  if (!room) return null;

  // Max 2 viewers — but evict stale connections first (network drop without clean WS close)
  if (room.viewers.size >= 2) {
    const now = Date.now();
    const stale = Array.from(room.viewers.values()).find(
      v => v.heartbeatAt > 0 && now - v.heartbeatAt > 1500
    );
    if (!stale) {
      send(ws, { type: 'ERROR', message: 'Room is full (max 2 viewers)' });
      return null;
    }
    try { stale.ws.terminate(); } catch { /* ignore */ }
    room.viewers.delete(stale.viewerId);
  }

  const viewerId = generateViewerId();
  const isHost = room.viewers.size === 0;

  const viewer: ViewerRuntime = {
    viewerId,
    ws,
    isHost,
    joinedAt: Date.now(),
    heartbeat: null,
    heartbeatAt: 0,
  };

  room.viewers.set(viewerId, viewer);

  // Determine current canonical time including elapsed
  const currentTime = room.state === 'PLAYING'
    ? room.canonicalTime + (Date.now() - room.canonicalTimeUpdatedAt) / 1000
    : room.canonicalTime;

  send(ws, {
    type: 'JOINED',
    viewerId,
    isHost,
    roomState: room.state,
    mediaUrl: `/api/media/${token}`,
    mediaFilename: room.mediaFilename,
    currentTime,
    subtitleUrl: hasSubtitles(room.mediaPath) ? `/api/subtitle/${token}` : undefined,
    hlsUrl: hasHLS(room.mediaPath) ? `/api/hls/${token}/index.m3u8` : undefined,
  });

  // Broadcast updated viewer count
  for (const v of room.viewers.values()) {
    send(v.ws, {
      type: 'ROOM_UPDATE',
      state: room.state,
      viewerCount: room.viewers.size,
    });
  }

  return viewerId;
}

export function leaveRoom(token: string, viewerId: string): void {
  const room = rooms.get(token);
  if (!room) return;

  persistLastTime(room);

  const { dispatches } = handleViewerDisconnect(room, viewerId);
  dispatch(room, dispatches);

  if (room.viewers.size === 0) {
    rooms.delete(token);
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

export function handleMessage(token: string, viewerId: string, raw: string): void {
  const room = rooms.get(token);
  if (!room) return;

  const viewer = room.viewers.get(viewerId);
  if (!viewer) return;

  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  if (msg.type === 'HEARTBEAT') {
    viewer.heartbeat = msg.data;
    viewer.heartbeatAt = Date.now();
  } else if (msg.type === 'USER_ACTION') {
    const { dispatches } = handleUserAction(room, viewerId, msg.data.action, msg.data.mediaTime);
    dispatch(room, dispatches);
    // Persist position whenever user pauses
    if (msg.data.action === 'PAUSE') persistLastTime(room);
  }
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

export function startTickLoop(): void {
  if (tickInterval) return;

  tickInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, room] of rooms) {
      // Clean up expired rooms
      if (now > room.expiresAt) {
        for (const v of room.viewers.values()) {
          send(v.ws, { type: 'ERROR', message: 'Room has expired' });
          v.ws.close();
        }
        rooms.delete(token);
        continue;
      }

      const { dispatches } = tick(room);
      dispatch(room, dispatches);
      room.lastTickAt = now;

      // Persist playback position every ~10s while playing
      if (room.state === 'PLAYING' && now - (room.lastPersistedAt ?? 0) > 10_000) {
        persistLastTime(room);
        room.lastPersistedAt = now;
      }
    }
  }, 500);
}

export function stopTickLoop(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

// ── WebSocket server setup ────────────────────────────────────────────────────

export function setupWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('roomToken');

    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      console.log(`[WS] rejected: invalid token`);
      send(ws, { type: 'ERROR', message: 'Invalid room token' });
      ws.close();
      return;
    }

    const viewerId = joinRoom(token, ws);
    if (!viewerId) {
      ws.close();
      return;
    }

    // Ping every 15s; terminate if no pong — background cleanup of truly dead
    // connections. Keep interval long to avoid false-terminating mobile connections
    // during normal network hiccups (cell handoffs, brief drops).
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const pingInterval = setInterval(() => {
      if (!alive) { clearInterval(pingInterval); ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 15_000);

    ws.on('message', (data) => {
      handleMessage(token, viewerId, data.toString());
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      leaveRoom(token, viewerId);
    });

    ws.on('error', () => {
      clearInterval(pingInterval);
      leaveRoom(token, viewerId);
    });
  });
}
