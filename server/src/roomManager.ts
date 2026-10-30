import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config';
import { getRoomByToken, updateLibraryLastTime, getLibraryMeta, normalizeResumeTime } from './db';
import { hasSubtitles, subtitlePath } from './subtitles';
import { hasHLS } from './ffmpeg';
import fs from 'fs';
import path from 'path';
import { tick, handleUserAction, handleViewerDisconnect } from './roomStateMachine';
import { parseClientMessage } from './clientMessages';
import type {
  RoomRuntime,
  ViewerRuntime,
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
    canonicalTime: (() => {
      const meta = getLibraryMeta(row.media_filename);
      return normalizeResumeTime(meta?.last_time ?? 0, meta?.duration ?? 0);
    })(),
    canonicalTimeUpdatedAt: Date.now(),
    wasPlayingBeforeInterruption: false,
    wasUserPaused: false,
    singlePlayer: false,
    pendingRateTarget: new Map(),
    lastTickAt: Date.now(),
    adaptiveResumeThreshold: config.bufferResumeThreshold,
  };

  rooms.set(token, runtime);
  return runtime;
}

export function getRuntimeByToken(token: string): RoomRuntime | null {
  return rooms.get(token) ?? null;
}

/** Sanitized runtime state for the token-protected diagnostics API. */
export function getDiagnosticsSnapshot() {
  const now = Date.now();
  return Array.from(rooms.values()).map(room => ({
    roomId: room.roomId,
    mediaFilename: room.mediaFilename,
    state: room.state,
    singlePlayer: room.singlePlayer ?? false,
    canonicalTime: room.canonicalTime,
    canonicalTimeAgeMs: now - room.canonicalTimeUpdatedAt,
    adaptiveResumeThreshold: room.adaptiveResumeThreshold,
    bufferingForMs: room.bufferingStartAt === undefined ? null : now - room.bufferingStartAt,
    forcedResumeAttempted: room.forcedResumeAttempted ?? false,
    lastPlayStartedAgoMs: room.lastPlayStartAt === undefined ? null : now - room.lastPlayStartAt,
    lastTickAgoMs: now - room.lastTickAt,
    viewers: Array.from(room.viewers.values()).map(viewer => ({
      viewerId: viewer.viewerId.slice(0, 8),
      role: viewer.isHost ? 'host' : 'peer',
      connectedForMs: now - viewer.joinedAt,
      heartbeatAgeMs: viewer.heartbeatAt === 0 ? null : now - viewer.heartbeatAt,
      heartbeat: viewer.heartbeat,
    })),
  }));
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

// Versioned by file so a changed subtitle gets past the one-hour HTTP cache,
// while a reconnect to the same file keeps the same URL and doesn't reload the track.
function currentSubtitleUrl(room: RoomRuntime): string | undefined {
  if (!hasSubtitles(room.mediaPath)) return undefined;
  const version = Math.trunc(fs.statSync(subtitlePath(room.mediaPath)).mtimeMs);
  return `/api/subtitle/${room.roomToken}?v=${version}`;
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
      v => v.heartbeatAt > 0 && now - v.heartbeatAt > 2500
    );
    if (!stale) {
      send(ws, { type: 'ERROR', message: 'Room is full (max 2 viewers)' });
      return null;
    }
    dispatch(room, handleViewerDisconnect(room, stale.viewerId).dispatches);
    try { stale.ws.terminate(); } catch { /* ignore */ }
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
    subtitleUrl: currentSubtitleUrl(room),
    hlsUrl: hasHLS(room.mediaPath) ? `/api/hls/${token}/index.m3u8` : undefined,
    singlePlayer: room.singlePlayer ?? false,
  });

  // Broadcast updated viewer count
  for (const v of room.viewers.values()) {
    send(v.ws, {
      type: 'ROOM_UPDATE',
      state: room.state,
      viewerCount: room.viewers.size,
      singlePlayer: room.singlePlayer ?? false,
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

  const msg = parseClientMessage(raw);
  if (!msg) return;

  if (msg.type === 'HEARTBEAT') {
    viewer.heartbeat = msg.data;
    viewer.heartbeatAt = Date.now();
  } else if (msg.type === 'USER_ACTION') {
    const { dispatches } = handleUserAction(room, viewerId, msg.data.action, msg.data.mediaTime);
    dispatch(room, dispatches);
    // Persist position whenever user pauses
    if (msg.data.action === 'PAUSE') persistLastTime(room);
  } else if (msg.type === 'SET_SINGLE_PLAYER') {
    room.singlePlayer = msg.enabled;
    // Re-tick immediately so toggling on/off takes effect right away rather
    // than waiting for the next 500ms tick.
    const { dispatches } = tick(room);
    dispatch(room, dispatches);
  }
}

// Library actions can change a film's subtitles while it's being watched.
export function notifySubtitlesChanged(mediaFilename: string): void {
  for (const room of rooms.values()) {
    if (room.mediaFilename !== mediaFilename) continue;
    const subtitleUrl = currentSubtitleUrl(room);
    for (const viewer of room.viewers.values()) send(viewer.ws, { type: 'SUBTITLES_CHANGED', subtitleUrl });
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

// Saves every room's position and drops its sockets. Upgraded WebSockets are
// invisible to the HTTP server, so app.close() would wait on them forever.
export function closeAllRooms(): void {
  for (const room of rooms.values()) {
    persistLastTime(room);
    for (const viewer of room.viewers.values()) viewer.ws.terminate();
  }
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
      // An exception here would be uncaught and take every room down with it.
      try {
        handleMessage(token, viewerId, data.toString());
      } catch (err) {
        console.error('[WS] message handler failed:', err);
      }
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
