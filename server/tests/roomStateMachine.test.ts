import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tick, handleUserAction, handleViewerDisconnect } from '../src/roomStateMachine';
import type { RoomRuntime, ViewerRuntime, ClientHeartbeat } from '../src/types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeHeartbeat(overrides: Partial<ClientHeartbeat> = {}): ClientHeartbeat {
  return {
    mediaTime: 0,
    paused: true,
    seeking: false,
    waiting: false,
    readyState: 4,
    bufferedAhead: 15,
    playbackRate: 1.0,
    lastUserAction: Date.now(),
    serverCommandPending: false,
    ...overrides,
  };
}

function makeViewer(id: string, isHost: boolean, hb?: Partial<ClientHeartbeat>): ViewerRuntime {
  const heartbeat = hb !== undefined ? makeHeartbeat(hb) : null;
  return {
    viewerId: id,
    ws: {} as any,
    isHost,
    joinedAt: Date.now(),
    heartbeat,
    heartbeatAt: hb !== undefined ? Date.now() : 0,
  };
}

function makeRoom(overrides: Partial<RoomRuntime> = {}): RoomRuntime {
  return {
    roomId: 'test-room',
    roomToken: 'a'.repeat(64),
    mediaPath: '/tmp/video.mp4',
    mediaFilename: 'video.mp4',
    mediaSize: 1000000,
    expiresAt: Date.now() + 3600 * 1000,
    state: 'WAITING_FOR_VIEWERS',
    viewers: new Map(),
    canonicalTime: 0,
    canonicalTimeUpdatedAt: Date.now(),
    wasPlayingBeforeInterruption: false,
    pendingRateTarget: new Map(),
    lastTickAt: Date.now(),
    ...overrides,
  };
}

function addViewer(room: RoomRuntime, viewer: ViewerRuntime): void {
  room.viewers.set(viewer.viewerId, viewer);
}

function getDispatchTypes(result: ReturnType<typeof tick>): string[] {
  return result.dispatches
    .filter(d => d.message.type !== 'PEER_STATUS')
    .map(d => d.message.type);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Room State Machine', () => {

  describe('WAITING_FOR_VIEWERS', () => {
    it('stays in WAITING_FOR_VIEWERS with 0 viewers', () => {
      const room = makeRoom();
      const result = tick(room);
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
      assert.equal(result.stateChanged, false);
    });

    it('stays in WAITING_FOR_VIEWERS with 1 viewer', () => {
      const room = makeRoom();
      addViewer(room, makeViewer('v1', true, {}));
      const result = tick(room);
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
      assert.equal(result.stateChanged, false);
    });

    it('transitions to READY_CHECK when 2 viewers with heartbeats', () => {
      const room = makeRoom();
      addViewer(room, makeViewer('v1', true, {}));
      addViewer(room, makeViewer('v2', false, {}));
      const result = tick(room);
      assert.equal(room.state, 'READY_CHECK');
      assert.equal(result.stateChanged, true);
    });

    it('does not transition with 2 viewers but stale heartbeats', () => {
      const room = makeRoom();
      const v1 = makeViewer('v1', true);
      v1.heartbeatAt = Date.now() - 10000; // stale
      const v2 = makeViewer('v2', false);
      v2.heartbeatAt = Date.now() - 10000;
      addViewer(room, v1);
      addViewer(room, v2);
      tick(room);
      // Still WAITING because no fresh heartbeats
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
    });
  });

  describe('READY_CHECK', () => {
    it('transitions to PLAYING when both have sufficient buffer', () => {
      const room = makeRoom({ state: 'READY_CHECK' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 12 }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.equal(result.stateChanged, true);
      const types = getDispatchTypes(result);
      assert.ok(types.includes('PLAY_AT'));
    });

    it('stays in READY_CHECK when one viewer has low buffer', () => {
      const room = makeRoom({ state: 'READY_CHECK' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 1 })); // below threshold
      tick(room);
      assert.equal(room.state, 'READY_CHECK');
    });

    it('transitions back to WAITING_FOR_VIEWERS if viewer disconnects', () => {
      const room = makeRoom({ state: 'READY_CHECK' });
      addViewer(room, makeViewer('v1', true, {}));
      // Only 1 viewer left
      const result = tick(room);
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
      assert.equal(result.stateChanged, true);
    });
  });

  describe('PLAYING', () => {
    it('transitions to BUFFERING when a viewer stalls', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 0.5, waiting: true, paused: false }));
      const result = tick(room);
      assert.equal(room.state, 'BUFFERING');
      const types = getDispatchTypes(result);
      assert.ok(types.includes('PAUSE'));
    });

    it('transitions to BUFFERING when bufferedAhead < 2', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 1.9, paused: false }));
      const result = tick(room);
      assert.equal(room.state, 'BUFFERING');
    });

    it('stays PLAYING when both have sufficient buffer', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 12, paused: false }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('transitions to SEEKING when a viewer is seeking (non-server)', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { seeking: true, serverCommandPending: false }));
      tick(room);
      assert.equal(room.state, 'SEEKING');
    });

    it('does not transition when seeking flag is from server command', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, {
        seeking: true,
        serverCommandPending: true, // server-initiated, ignore
        bufferedAhead: 12,
      }));
      tick(room);
      assert.equal(room.state, 'PLAYING'); // should stay playing
    });

    it('ignores buffering when serverCommandPending', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, {
        bufferedAhead: 0,
        waiting: true,
        serverCommandPending: true,
      }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });
  });

  describe('BUFFERING', () => {
    it('resumes to PLAYING when both have sufficient buffer', () => {
      const room = makeRoom({ state: 'BUFFERING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 12 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 11 }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.equal(result.stateChanged, true);
      const types = getDispatchTypes(result);
      assert.ok(types.includes('PLAY_AT'));
    });

    it('stays BUFFERING when one viewer still has low buffer', () => {
      const room = makeRoom({ state: 'BUFFERING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 12 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 5 })); // below resume threshold
      tick(room);
      assert.equal(room.state, 'BUFFERING');
    });

    it('requires bufferedAhead >= 10 to resume (hysteresis)', () => {
      const room = makeRoom({ state: 'BUFFERING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 12 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 9.9 })); // just below 10
      tick(room);
      assert.equal(room.state, 'BUFFERING');
    });
  });

  describe('USER_PAUSED', () => {
    it('stays USER_PAUSED on tick (not auto-resumed)', () => {
      const room = makeRoom({ state: 'USER_PAUSED' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 15 }));
      tick(room);
      assert.equal(room.state, 'USER_PAUSED');
    });

    it('resumes to PLAYING on USER_ACTION PLAY when both ready', () => {
      const room = makeRoom({ state: 'USER_PAUSED' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 12 }));
      const result = handleUserAction(room, 'v1', 'PLAY');
      assert.equal(room.state, 'PLAYING');
      const types = result.dispatches
        .filter(d => d.message.type !== 'PEER_STATUS')
        .map(d => d.message.type);
      assert.ok(types.includes('PLAY_AT'));
    });

    it('transitions to BUFFERING on PLAY when viewers not ready', () => {
      const room = makeRoom({ state: 'USER_PAUSED' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 2 })); // below resume threshold
      handleUserAction(room, 'v1', 'PLAY');
      assert.equal(room.state, 'BUFFERING');
    });
  });

  describe('USER_ACTION PAUSE', () => {
    it('pauses a PLAYING room', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, mediaTime: 30 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 12, mediaTime: 30 }));
      const result = handleUserAction(room, 'v1', 'PAUSE');
      assert.equal(room.state, 'USER_PAUSED');
      const types = result.dispatches.map(d => d.message.type);
      assert.ok(types.includes('PAUSE'));
    });
  });

  describe('USER_ACTION SEEK', () => {
    it('puts room into SEEKING state', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { mediaTime: 10 }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 10 }));
      const result = handleUserAction(room, 'v1', 'SEEK', 60);
      assert.equal(room.state, 'SEEKING');
      const types = result.dispatches.map(d => d.message.type);
      assert.ok(types.includes('SEEK'));
      assert.equal(room.canonicalTime, 60);
    });

    it('records wasPlayingBeforeInterruption when seeking from PLAYING', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, {}));
      handleUserAction(room, 'v1', 'SEEK', 60);
      assert.equal(room.wasPlayingBeforeInterruption, true);
    });

    it('records wasPlayingBeforeInterruption=false when seeking from USER_PAUSED', () => {
      const room = makeRoom({ state: 'USER_PAUSED' });
      addViewer(room, makeViewer('v1', true, {}));
      handleUserAction(room, 'v1', 'SEEK', 60);
      assert.equal(room.wasPlayingBeforeInterruption, false);
    });
  });

  describe('SEEKING recovery', () => {
    it('resumes PLAYING after all viewers finish seeking (was playing)', () => {
      const room = makeRoom({ state: 'SEEKING', wasPlayingBeforeInterruption: true });
      addViewer(room, makeViewer('v1', true, { seeking: false, bufferedAhead: 12 }));
      addViewer(room, makeViewer('v2', false, { seeking: false, bufferedAhead: 11 }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      const types = getDispatchTypes(result);
      assert.ok(types.includes('PLAY_AT'));
    });

    it('transitions to USER_PAUSED after seeking if was paused', () => {
      const room = makeRoom({ state: 'SEEKING', wasPlayingBeforeInterruption: false });
      addViewer(room, makeViewer('v1', true, { seeking: false, bufferedAhead: 12 }));
      addViewer(room, makeViewer('v2', false, { seeking: false, bufferedAhead: 11 }));
      tick(room);
      assert.equal(room.state, 'USER_PAUSED');
    });
  });

  describe('Viewer disconnect', () => {
    it('transitions to WAITING_FOR_VIEWERS on disconnect from PLAYING', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, {}));
      addViewer(room, makeViewer('v2', false, {}));
      const result = handleViewerDisconnect(room, 'v2');
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
      assert.equal(room.viewers.size, 1);
      const types = result.dispatches.map(d => d.message.type);
      assert.ok(types.includes('PAUSE'));
    });
  });

  describe('Drift correction', () => {
    it('ignores drift < 250ms', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { mediaTime: 100.0, bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 100.2, bufferedAhead: 12, paused: false }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      const rateAdjusts = result.dispatches.filter(d => d.message.type === 'RATE_ADJUST');
      assert.equal(rateAdjusts.length, 0);
    });

    it('adjusts playback rate for 250ms-1500ms drift', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { mediaTime: 100.0, bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 101.0, bufferedAhead: 12, paused: false })); // 1s ahead
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      const rateAdjusts = result.dispatches.filter(d => d.message.type === 'RATE_ADJUST');
      assert.ok(rateAdjusts.length > 0);
    });

    it('triggers RESYNCING for drift > driftRateThreshold (5s)', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { mediaTime: 100.0, bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 106.0, bufferedAhead: 12, paused: false })); // 6s ahead
      const result = tick(room);
      assert.equal(room.state, 'RESYNCING');
      const types = getDispatchTypes(result);
      assert.ok(types.includes('SEEK'));
    });

    it('raises adaptiveResumeThreshold when resyncs repeat shortly after resuming', () => {
      // Simulate a chronic (not transient) drift problem: playback only just
      // resumed, and drift is already past threshold again — the same pattern
      // BUFFERING's quick-re-stall detection uses, applied to resync storms.
      const room = makeRoom({ state: 'PLAYING', lastPlayStartAt: Date.now() - 500, adaptiveResumeThreshold: 1.5 });
      const before = room.adaptiveResumeThreshold;
      addViewer(room, makeViewer('v1', true, { mediaTime: 100.0, bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 106.0, bufferedAhead: 12, paused: false }));
      tick(room);
      assert.equal(room.state, 'RESYNCING');
      assert.ok(room.adaptiveResumeThreshold > before);
    });

    it('does not raise adaptiveResumeThreshold when a resync follows a long stable stretch', () => {
      const room = makeRoom({ state: 'PLAYING', lastPlayStartAt: Date.now() - 120_000 });
      room.adaptiveResumeThreshold = 5;
      addViewer(room, makeViewer('v1', true, { mediaTime: 100.0, bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 106.0, bufferedAhead: 12, paused: false }));
      tick(room);
      assert.equal(room.state, 'RESYNCING');
      assert.ok(room.adaptiveResumeThreshold < 5);
    });
  });
});
