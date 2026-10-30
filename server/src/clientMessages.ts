import type { ClientHeartbeat, ClientMessage } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isHeartbeat(data: unknown): data is ClientHeartbeat {
  if (!isRecord(data)) return false;
  const numbers = ['mediaTime', 'readyState', 'bufferedAhead', 'playbackRate', 'lastUserAction'];
  const flags = ['paused', 'ended', 'seeking', 'waiting', 'serverCommandPending'];
  return numbers.every(key => isFiniteNumber(data[key]))
    && flags.every(key => typeof data[key] === 'boolean')
    && (data.playbackBlocked === undefined || typeof data.playbackBlocked === 'boolean');
}

// WebSocket frames come straight from room-link holders, and a throw inside a
// ws 'message' listener is uncaught — anything unrecognized becomes null here.
export function parseClientMessage(raw: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg)) return null;

  if (msg.type === 'HEARTBEAT') {
    return isHeartbeat(msg.data) ? { type: 'HEARTBEAT', data: msg.data } : null;
  }
  if (msg.type === 'SET_SINGLE_PLAYER') {
    return typeof msg.enabled === 'boolean' ? { type: 'SET_SINGLE_PLAYER', enabled: msg.enabled } : null;
  }
  if (msg.type === 'USER_ACTION' && isRecord(msg.data)) {
    const { action, mediaTime } = msg.data;
    if (action === 'PLAY' || action === 'PAUSE') return { type: 'USER_ACTION', data: { action } };
    if (action === 'SEEK' && isFiniteNumber(mediaTime) && mediaTime >= 0) {
      return { type: 'USER_ACTION', data: { action, mediaTime } };
    }
  }
  return null;
}
