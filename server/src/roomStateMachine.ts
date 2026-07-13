import { config } from './config';
import type {
  RoomState,
  RoomRuntime,
  ViewerRuntime,
  ServerMessage,
  ClientHeartbeat,
  UserActionType,
} from './types';

export interface DispatchItem {
  viewerId: string; // viewer to send to, or 'ALL'
  message: ServerMessage;
}

export interface TickResult {
  dispatches: DispatchItem[];
  stateChanged: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function activeViewers(room: RoomRuntime): ViewerRuntime[] {
  const now = Date.now();
  return Array.from(room.viewers.values()).filter(
    v => now - v.heartbeatAt < config.heartbeatStaleMs && v.heartbeat !== null
  );
}

function allViewers(room: RoomRuntime): ViewerRuntime[] {
  return Array.from(room.viewers.values());
}

function isBuffering(hb: ClientHeartbeat): boolean {
  if (hb.serverCommandPending) return false;
  if (hb.waiting) return true;                 // video literally stalled — always act
  // readyState>=4 (HAVE_ENOUGH_DATA) only means "the current instant is covered" — it
  // stays true right up until the buffer actually empties, so trusting it unconditionally
  // let a slow bandwidth bleed drain all the way to ~0s without ever triggering a
  // protective pause (confirmed live: buf 53s -> 0.1s over 90s with readyState==4 the
  // whole way). Always check the margin instead.
  return hb.bufferedAhead < config.bufferPauseThreshold;
}

function isSeeking(hb: ClientHeartbeat): boolean {
  return !hb.serverCommandPending && hb.seeking;
}

function isReadyToPlay(hb: ClientHeartbeat, threshold: number = config.bufferResumeThreshold): boolean {
  if (hb.serverCommandPending || hb.seeking || hb.waiting) return false;
  // Same readyState>=4 pitfall as isBuffering above: it means "covered for this instant,"
  // not "has a real cushion" — trusting it here let a viewer resume with almost no
  // buffer margin at all. The bufferedAhead threshold is the actual signal.
  return hb.bufferedAhead >= threshold;
}

function canonicalTimeNow(room: RoomRuntime): number {
  if (room.state !== 'PLAYING') return room.canonicalTime;
  const elapsed = (Date.now() - room.canonicalTimeUpdatedAt) / 1000;
  return room.canonicalTime + elapsed;
}

function updateCanonicalTime(room: RoomRuntime, time: number): void {
  room.canonicalTime = time;
  room.canonicalTimeUpdatedAt = Date.now();
}

function broadcast(room: RoomRuntime, msg: ServerMessage): DispatchItem[] {
  return allViewers(room).map(v => ({ viewerId: v.viewerId, message: msg }));
}

function broadcastActive(room: RoomRuntime, msg: ServerMessage, active: ViewerRuntime[]): DispatchItem[] {
  return active.map(v => ({ viewerId: v.viewerId, message: msg }));
}

function buildPlayAt(room: RoomRuntime): DispatchItem[] {
  // Use room.canonicalTime directly — NOT canonicalTimeNow() — to avoid adding elapsed
  // time from BUFFERING/SEEKING states where state is set to PLAYING before this call.
  const targetTime = room.canonicalTime;
  const wallClockTime = Date.now() + config.playAtLookaheadMs;
  updateCanonicalTime(room, targetTime);
  return broadcast(room, { type: 'PLAY_AT', mediaTime: targetTime, wallClockTime });
}

function buildPauseAll(room: RoomRuntime): DispatchItem[] {
  const t = canonicalTimeNow(room);
  updateCanonicalTime(room, t);
  return broadcast(room, { type: 'PAUSE', mediaTime: t });
}

function buildSeekAll(room: RoomRuntime, time: number): DispatchItem[] {
  updateCanonicalTime(room, time);
  return broadcast(room, { type: 'SEEK', mediaTime: time });
}

function buildRoomUpdate(room: RoomRuntime): DispatchItem[] {
  const msg: ServerMessage = {
    type: 'ROOM_UPDATE',
    state: room.state,
    viewerCount: room.viewers.size,
  };
  return broadcast(room, msg);
}

function setRoomState(room: RoomRuntime, newState: RoomState): void {
  room.state = newState;
}

// ── Peer status broadcast ────────────────────────────────────────────────────

function buildPeerStatuses(room: RoomRuntime): DispatchItem[] {
  const dispatches: DispatchItem[] = [];
  const viewers = allViewers(room);
  if (viewers.length < 2) return dispatches;

  for (const viewer of viewers) {
    // Send the OTHER viewer's status to this viewer
    const peer = viewers.find(v => v.viewerId !== viewer.viewerId);
    if (!peer || !peer.heartbeat) continue;
    dispatches.push({
      viewerId: viewer.viewerId,
      message: {
        type: 'PEER_STATUS',
        bufferedAhead: peer.heartbeat.bufferedAhead,
        mediaTime: peer.heartbeat.mediaTime,
        seeking: peer.heartbeat.seeking,
        waiting: peer.heartbeat.waiting,
      },
    });
  }
  return dispatches;
}

// ── Drift correction ─────────────────────────────────────────────────────────

function handleDrift(room: RoomRuntime, active: ViewerRuntime[]): DispatchItem[] {
  if (active.length < 2) return [];

  // Host is the first viewer who joined (or the one marked isHost)
  const host = active.find(v => v.isHost) ?? active[0];
  const peer = active.find(v => v.viewerId !== host.viewerId);
  if (!host.heartbeat || !peer?.heartbeat) return [];

  const drift = peer.heartbeat.mediaTime - host.heartbeat.mediaTime;
  const absDrift = Math.abs(drift);

  if (absDrift < config.driftIgnoreThreshold) {
    // Reset rates if they were adjusted
    const dispatches: DispatchItem[] = [];
    if (host.heartbeat.playbackRate !== 1.0) {
      dispatches.push({ viewerId: host.viewerId, message: { type: 'RATE_ADJUST', playbackRate: 1.0 } });
    }
    if (peer.heartbeat.playbackRate !== 1.0) {
      dispatches.push({ viewerId: peer.viewerId, message: { type: 'RATE_ADJUST', playbackRate: 1.0 } });
    }
    return dispatches;
  }

  if (absDrift > config.driftRateThreshold) {
    // Large drift: resync — but apply a 5s cooldown to avoid seek storms
    const now = Date.now();
    if (now - (room.lastResyncAt ?? 0) < 5000) return [];
    room.lastResyncAt = now;

    // A resync shortly after the last resume means the drift is chronic (usually
    // one side has a sustained bandwidth/decode deficit), not a one-off blip —
    // a seek alone doesn't fix that, and immediately resuming at the same low
    // buffer bar just repeats the cycle. Raise the bar before letting anyone
    // resume again, the same way a quick re-stall raises it during BUFFERING;
    // decay it back down after a long stable stretch, same as that branch too.
    const playedMs = now - (room.lastPlayStartAt ?? 0);
    if (playedMs < config.bufferQuickStallMs) {
      room.adaptiveResumeThreshold = Math.min(
        room.adaptiveResumeThreshold + 1,
        config.bufferResumeThresholdMax
      );
    } else if (playedMs > config.bufferStableMs) {
      room.adaptiveResumeThreshold = Math.max(
        room.adaptiveResumeThreshold - 0.5,
        config.bufferResumeThreshold
      );
    }

    setRoomState(room, 'RESYNCING');
    room.wasPlayingBeforeInterruption = true;
    const targetTime = Math.min(host.heartbeat.mediaTime, peer.heartbeat.mediaTime);
    updateCanonicalTime(room, targetTime);
    return [
      ...buildSeekAll(room, targetTime),
      ...buildRoomUpdate(room),
    ];
  }

  // Small drift: nudge playback rate only when the rate isn't already correct
  // drift > 0 means peer is ahead of host → slow peer, speed host
  // drift < 0 means peer is behind host → speed peer, slow host
  const dispatches: DispatchItem[] = [];
  if (drift > config.driftIgnoreThreshold) {
    if (peer.heartbeat.playbackRate !== config.playbackRateSlow)
      dispatches.push({ viewerId: peer.viewerId, message: { type: 'RATE_ADJUST', playbackRate: config.playbackRateSlow } });
    if (host.heartbeat.playbackRate !== config.playbackRateFast)
      dispatches.push({ viewerId: host.viewerId, message: { type: 'RATE_ADJUST', playbackRate: config.playbackRateFast } });
  } else {
    if (peer.heartbeat.playbackRate !== config.playbackRateFast)
      dispatches.push({ viewerId: peer.viewerId, message: { type: 'RATE_ADJUST', playbackRate: config.playbackRateFast } });
    if (host.heartbeat.playbackRate !== config.playbackRateSlow)
      dispatches.push({ viewerId: host.viewerId, message: { type: 'RATE_ADJUST', playbackRate: config.playbackRateSlow } });
  }
  return dispatches;
}

// ── Main tick ─────────────────────────────────────────────────────────────────

export function tick(room: RoomRuntime): TickResult {
  const dispatches: DispatchItem[] = [];
  const prevState = room.state;
  const active = activeViewers(room);
  const totalConnected = room.viewers.size;

  // Always broadcast peer status
  dispatches.push(...buildPeerStatuses(room));

  switch (room.state) {
    case 'WAITING_FOR_VIEWERS': {
      if (active.length >= 2) {
        setRoomState(room, 'READY_CHECK');
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'READY_CHECK': {
      if (active.length < 2) {
        setRoomState(room, 'WAITING_FOR_VIEWERS');
        dispatches.push(...buildRoomUpdate(room));
      } else if (active.every(v => v.heartbeat && isReadyToPlay(v.heartbeat, room.adaptiveResumeThreshold))) {
        if (room.wasUserPaused) {
          room.wasUserPaused = false;
          setRoomState(room, 'USER_PAUSED');
          dispatches.push(...buildPauseAll(room));
        } else {
          room.lastPlayStartAt = Date.now();
          setRoomState(room, 'PLAYING');
          dispatches.push(...buildPlayAt(room));
        }
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'PLAYING': {
      if (active.length < 2 && totalConnected < 2) {
        setRoomState(room, 'WAITING_FOR_VIEWERS');
        dispatches.push(...buildPauseAll(room));
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      // Check for seeking first (user-initiated)
      if (active.some(v => v.heartbeat && isSeeking(v.heartbeat))) {
        setRoomState(room, 'SEEKING');
        room.wasPlayingBeforeInterruption = true;
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      // Check for buffering
      if (active.some(v => v.heartbeat && isBuffering(v.heartbeat))) {
        // Adaptive threshold: quick re-stall → raise, else decay toward base
        const playedMs = Date.now() - (room.lastPlayStartAt ?? 0);
        if (playedMs < config.bufferQuickStallMs) {
          room.adaptiveResumeThreshold = Math.min(
            room.adaptiveResumeThreshold + 1,
            config.bufferResumeThresholdMax
          );
        } else if (playedMs > config.bufferStableMs) {
          room.adaptiveResumeThreshold = Math.max(
            room.adaptiveResumeThreshold - 0.5,
            config.bufferResumeThreshold
          );
        }
        setRoomState(room, 'BUFFERING');
        room.wasPlayingBeforeInterruption = true;
        room.bufferingStartAt = Date.now();
        dispatches.push(...buildPauseAll(room));
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      // Update canonical time from host heartbeat
      const host = active.find(v => v.isHost) ?? active[0];
      if (host?.heartbeat && !host.heartbeat.paused) {
        updateCanonicalTime(room, host.heartbeat.mediaTime);
      }

      // Check for video ended — use the explicit ended flag from the browser rather than
      // inferring from bufferedAhead===0, which can false-positive after seeks near EOF.
      if (active.every(v => v.heartbeat && !v.heartbeat.serverCommandPending && v.heartbeat.ended)) {
        setRoomState(room, 'ENDED');
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      // Skip drift correction while any client is applying a server command —
      // heartbeats during srvCmd=true report stale mediaTime, creating false drift.
      if (active.every(v => !v.heartbeat?.serverCommandPending)) {
        dispatches.push(...handleDrift(room, active));
      }
      break;
    }

    case 'USER_PAUSED': {
      if (active.length < 2 && totalConnected < 2) {
        room.wasUserPaused = true;
        setRoomState(room, 'WAITING_FOR_VIEWERS');
        dispatches.push(...buildRoomUpdate(room));
      }
      // Stay paused — only USER_ACTION PLAY can exit this state
      break;
    }

    case 'BUFFERING': {
      if (active.length < 2 && totalConnected < 2) {
        setRoomState(room, 'WAITING_FOR_VIEWERS');
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      const t = room.adaptiveResumeThreshold;
      const allReady = active.every(v => v.heartbeat && isReadyToPlay(v.heartbeat, t));
      // Timeout: if stuck >15s and at least one viewer is ready, force PLAY_AT.
      // iOS Safari only buffers aggressively while "playing", so this unsticks it.
      const bufferingTimedOut = Date.now() - (room.bufferingStartAt ?? Date.now()) > 15_000
        && active.some(v => v.heartbeat && isReadyToPlay(v.heartbeat, t));

      if (allReady || bufferingTimedOut) {
        room.bufferingStartAt = undefined;
        room.lastPlayStartAt = Date.now();
        setRoomState(room, 'PLAYING');
        dispatches.push(...buildPlayAt(room));
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'SEEKING': {
      if (active.length < 2 && totalConnected < 2) {
        setRoomState(room, 'WAITING_FOR_VIEWERS');
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      if (active.every(v => v.heartbeat && !isSeeking(v.heartbeat) && isReadyToPlay(v.heartbeat, room.adaptiveResumeThreshold))) {
        if (room.wasPlayingBeforeInterruption) {
          room.lastPlayStartAt = Date.now();
          setRoomState(room, 'PLAYING');
          dispatches.push(...buildPlayAt(room));
        } else {
          setRoomState(room, 'USER_PAUSED');
        }
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'RESYNCING': {
      if (active.length < 2 && totalConnected < 2) {
        setRoomState(room, 'WAITING_FOR_VIEWERS');
        dispatches.push(...buildRoomUpdate(room));
        break;
      }

      if (active.every(v => v.heartbeat && !isSeeking(v.heartbeat) && isReadyToPlay(v.heartbeat, room.adaptiveResumeThreshold))) {
        room.lastPlayStartAt = Date.now();
        setRoomState(room, 'PLAYING');
        dispatches.push(...buildPlayAt(room));
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'ENDED': {
      // Terminal: nothing to do
      break;
    }
  }

  return {
    dispatches,
    stateChanged: room.state !== prevState,
  };
}

// ── User action handler ───────────────────────────────────────────────────────

export function handleUserAction(
  room: RoomRuntime,
  viewerId: string,
  action: UserActionType,
  mediaTime?: number
): TickResult {
  const dispatches: DispatchItem[] = [];
  const prevState = room.state;

  switch (action) {
    case 'PLAY': {
      if (room.state === 'USER_PAUSED' || room.state === 'READY_CHECK') {
        room.wasUserPaused = false;
        const active = activeViewers(room);
        if (active.length >= 2 && active.every(v => v.heartbeat && isReadyToPlay(v.heartbeat, room.adaptiveResumeThreshold))) {
          room.lastPlayStartAt = Date.now();
          setRoomState(room, 'PLAYING');
          dispatches.push(...buildPlayAt(room));
        } else {
          setRoomState(room, 'BUFFERING');
          room.bufferingStartAt = Date.now();
          dispatches.push(...buildPauseAll(room));
        }
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'PAUSE': {
      if (room.state === 'PLAYING' || room.state === 'BUFFERING' || room.state === 'RESYNCING' || room.state === 'SEEKING') {
        setRoomState(room, 'USER_PAUSED');
        const t = canonicalTimeNow(room);
        updateCanonicalTime(room, t);
        dispatches.push(...broadcast(room, { type: 'PAUSE', mediaTime: t }));
        dispatches.push(...buildRoomUpdate(room));
      }
      break;
    }

    case 'SEEK': {
      if (mediaTime === undefined) break;
      updateCanonicalTime(room, mediaTime);

      // Any active state (playing, buffering, resyncing, seeking) means we want to
      // resume after the seek. Only stay paused if we were explicitly USER_PAUSED.
      room.wasPlayingBeforeInterruption =
        room.state !== 'USER_PAUSED' &&
        room.state !== 'WAITING_FOR_VIEWERS' &&
        room.state !== 'ENDED';

      setRoomState(room, 'SEEKING');
      dispatches.push(...buildSeekAll(room, mediaTime));
      dispatches.push(...buildRoomUpdate(room));
      break;
    }
  }

  return {
    dispatches,
    stateChanged: room.state !== prevState,
  };
}

// ── Viewer disconnect ─────────────────────────────────────────────────────────

export function handleViewerDisconnect(room: RoomRuntime, viewerId: string): TickResult {
  const dispatches: DispatchItem[] = [];
  room.viewers.delete(viewerId);

  const prevState = room.state;
  room.wasUserPaused = room.state === 'USER_PAUSED';

  if (room.state === 'PLAYING' || room.state === 'BUFFERING' || room.state === 'RESYNCING' || room.state === 'SEEKING') {
    const t = canonicalTimeNow(room);
    updateCanonicalTime(room, t);
    dispatches.push(...buildPauseAll(room));
  }

  setRoomState(room, 'WAITING_FOR_VIEWERS');
  dispatches.push(...buildRoomUpdate(room));

  return {
    dispatches,
    stateChanged: room.state !== prevState,
  };
}
