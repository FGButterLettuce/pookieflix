import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tick, handleUserAction, handleViewerDisconnect } from '../src/roomStateMachine';
import type { RoomRuntime, ViewerRuntime, ClientHeartbeat } from '../src/types';
import { config } from '../src/config';

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
    joinedAt: Date.now() - 10_000,
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
    adaptiveResumeThreshold: config.bufferResumeThreshold,
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

  describe('Single player mode', () => {
    it('does not transition past WAITING_FOR_VIEWERS with 1 viewer when singlePlayer is off', () => {
      const room = makeRoom({ singlePlayer: false });
      addViewer(room, makeViewer('v1', true, {}));
      const result = tick(room);
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
      assert.equal(result.stateChanged, false);
    });

    it('transitions to READY_CHECK with just 1 viewer when singlePlayer is on', () => {
      const room = makeRoom({ singlePlayer: true });
      addViewer(room, makeViewer('v1', true, {}));
      const result = tick(room);
      assert.equal(room.state, 'READY_CHECK');
      assert.equal(result.stateChanged, true);
    });

    it('starts PLAYING with 1 ready viewer when singlePlayer is on', () => {
      const room = makeRoom({ state: 'READY_CHECK', singlePlayer: true });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(getDispatchTypes(result).includes('PLAY_AT'));
    });

    it('stays PLAYING with just 1 viewer when singlePlayer is on', () => {
      const room = makeRoom({ state: 'PLAYING', singlePlayer: true });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15, paused: false, mediaTime: 10 }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('reverts to WAITING_FOR_VIEWERS when the only viewer drops out, even with singlePlayer on', () => {
      const room = makeRoom({ state: 'PLAYING', singlePlayer: true });
      // No viewers left connected at all
      const result = tick(room);
      assert.equal(room.state, 'WAITING_FOR_VIEWERS');
      assert.equal(result.stateChanged, true);
    });

    it('PLAY user action starts playback solo when singlePlayer is on', () => {
      const room = makeRoom({ state: 'USER_PAUSED', singlePlayer: true });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      const result = handleUserAction(room, 'v1', 'PLAY');
      assert.equal(room.state, 'PLAYING');
      assert.ok(result.dispatches.some(d => d.message.type === 'PLAY_AT'));
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

    it('force-resumes once after 15s if at least one viewer is ready (unsticks lazy-buffering Safari)', () => {
      const room = makeRoom({ state: 'BUFFERING', bufferingStartAt: Date.now() - 16_000 });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 12 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 0 })); // never actually ready
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(getDispatchTypes(result).includes('PLAY_AT'));
    });

    it('does not force-resume a second time in the same incident once the first forced resume immediately re-fails (livelock)', () => {
      // Reproduces the real Guardians/Ultron incident: a genuinely-stuck viewer's buffer
      // never recovers, so every 15s the room forced PLAY_AT, the stuck viewer instantly
      // failed its buffer check again, and the room bounced right back to BUFFERING —
      // forever, also yanking the healthy viewer's playback every cycle.
      // v1's buffer is deliberately large (matches the real incident's 60s+ mobile buffer)
      // so the unrelated adaptive-resume-threshold escalation (which raises the bar after
      // a quick re-stall) can't accidentally flip v1 to "not ready" and mask this bug.
      const room = makeRoom({ state: 'BUFFERING', bufferingStartAt: Date.now() - 16_000 });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 60 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 0 }));

      // First forced resume fires as usual.
      let result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(getDispatchTypes(result).includes('PLAY_AT'));

      // v2 is still stuck, so PLAYING immediately re-detects buffering and bounces back.
      result = tick(room);
      assert.equal(room.state, 'BUFFERING');

      // Another 16s pass with v2 STILL stuck — same incident, already used our one shot.
      room.bufferingStartAt = Date.now() - 16_000;
      result = tick(room);
      assert.equal(room.state, 'BUFFERING');
      assert.ok(!getDispatchTypes(result).includes('PLAY_AT'));

      // A genuine recovery (v2 actually becomes ready) still resumes normally.
      room.viewers.get('v2')!.heartbeat = makeHeartbeat({ bufferedAhead: 12 });
      result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(getDispatchTypes(result).includes('PLAY_AT'));
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

  describe('Viewers with stale heartbeats', () => {
    const makeStale = (viewer: ViewerRuntime): ViewerRuntime => {
      viewer.heartbeatAt = Date.now() - config.heartbeatStaleMs - 1000;
      return viewer;
    };

    it('keeps a room PLAYING when both connected viewers briefly go quiet', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeStale(makeViewer('v1', true, { paused: false })));
      addViewer(room, makeStale(makeViewer('v2', false, { paused: false })));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('keeps a single-player room PLAYING while its one device is backgrounded', () => {
      const room = makeRoom({ state: 'PLAYING', singlePlayer: true });
      addViewer(room, makeStale(makeViewer('v1', true, { paused: false })));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    for (const state of ['BUFFERING', 'SEEKING', 'RESYNCING'] as const) {
      it(`does not resume from ${state} with nobody active`, () => {
        const room = makeRoom({ state, bufferingStartAt: Date.now() });
        addViewer(room, makeStale(makeViewer('v1', true, { bufferedAhead: 60 })));
        addViewer(room, makeStale(makeViewer('v2', false, { bufferedAhead: 60 })));
        const result = tick(room);
        assert.equal(room.state, state);
        assert.equal(result.dispatches.some(d => d.message.type === 'PLAY_AT'), false);
      });
    }
  });

  describe('End of film', () => {
    it('ends the room when both videos have ended, even with nothing buffered', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { ended: true, paused: true, bufferedAhead: 0, mediaTime: 7200 }));
      addViewer(room, makeViewer('v2', false, { ended: true, paused: true, bufferedAhead: 0, mediaTime: 7200 }));
      tick(room);
      assert.equal(room.state, 'ENDED');
    });

    it('does not treat the viewer who finished first as buffering', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { ended: true, paused: true, bufferedAhead: 0, mediaTime: 7200 }));
      addViewer(room, makeViewer('v2', false, { paused: false, bufferedAhead: 3600, mediaTime: 7199.8 }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('waits for the second viewer to finish before ending', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { ended: true, paused: true, bufferedAhead: 3600, mediaTime: 7200 }));
      const quiet = makeViewer('v2', false, { paused: false, bufferedAhead: 3600, mediaTime: 7199.9 });
      quiet.heartbeatAt = Date.now() - config.heartbeatStaleMs - 1000;
      addViewer(room, quiet);
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });
  });

  describe('One-shot force resume', () => {
    const stalled = () => {
      const room = makeRoom({ state: 'PLAYING', forcedResumeAttempted: true });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 0.5, paused: false, mediaTime: 100 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 60, paused: false, mediaTime: 100 }));
      return room;
    };

    it('stays spent across a quick re-stall', () => {
      const room = stalled();
      room.lastPlayStartAt = Date.now() - 2000;
      tick(room);
      assert.equal(room.state, 'BUFFERING');
      assert.equal(room.forcedResumeAttempted, true);
    });

    it('is available again for a stall after stable playback', () => {
      const room = stalled();
      room.lastPlayStartAt = Date.now() - config.bufferStableMs - 60_000;
      tick(room);
      assert.equal(room.state, 'BUFFERING');
      room.bufferingStartAt = Date.now() - 16_000;
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(result.dispatches.some(d => d.message.type === 'PLAY_AT'));
    });

    it('is available again after a user seek', () => {
      const room = makeRoom({ state: 'BUFFERING', forcedResumeAttempted: true });
      handleUserAction(room, 'v1', 'SEEK', 500);
      assert.equal(room.forcedResumeAttempted, false);
    });
  });

  describe('Viewer disconnect bookkeeping', () => {
    it('keeps a remembered user pause when the second viewer also drops', () => {
      const room = makeRoom({ state: 'USER_PAUSED' });
      addViewer(room, makeViewer('v1', true, {}));
      addViewer(room, makeViewer('v2', false, {}));
      handleViewerDisconnect(room, 'v1');
      handleViewerDisconnect(room, 'v2');
      assert.equal(room.wasUserPaused, true);
    });

    it('does not invent a user pause for a playing room', () => {
      const room = makeRoom({ state: 'PLAYING', wasUserPaused: false });
      addViewer(room, makeViewer('v1', true, {}));
      handleViewerDisconnect(room, 'v1');
      assert.equal(room.wasUserPaused, false);
    });

    it('treats a repeat disconnect for the same viewer as a no-op', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v2', false, {}));
      const result = handleViewerDisconnect(room, 'already-gone');
      assert.equal(room.state, 'PLAYING');
      assert.deepEqual(result.dispatches, []);
    });
  });

  describe('Waiting states cannot wait forever', () => {
    const longAgo = () => Date.now() - 16_000;
    const twoViewers = (room: RoomRuntime) => {
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 60 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 1 }));
      return room;
    };

    it('nudges READY_CHECK once after the timeout when one viewer is ready', () => {
      const room = twoViewers(makeRoom({ state: 'READY_CHECK', bufferingStartAt: longAgo() }));
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(result.dispatches.some(d => d.message.type === 'PLAY_AT'));
      assert.equal(room.forcedResumeAttempted, true);
    });

    it('nudges SEEKING when playback was running before the seek', () => {
      const room = twoViewers(makeRoom({ state: 'SEEKING', wasPlayingBeforeInterruption: true, bufferingStartAt: longAgo() }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('nudges RESYNCING', () => {
      const room = twoViewers(makeRoom({ state: 'RESYNCING', bufferingStartAt: longAgo() }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('does not start playback for a seek made while paused', () => {
      const room = twoViewers(makeRoom({ state: 'SEEKING', wasPlayingBeforeInterruption: false, bufferingStartAt: longAgo() }));
      tick(room);
      assert.equal(room.state, 'SEEKING');
    });

    it('does not override a remembered user pause in READY_CHECK', () => {
      const room = twoViewers(makeRoom({ state: 'READY_CHECK', wasUserPaused: true, bufferingStartAt: longAgo() }));
      tick(room);
      assert.equal(room.state, 'READY_CHECK');
    });

    it('does not nudge before the timeout', () => {
      const room = twoViewers(makeRoom({ state: 'READY_CHECK', bufferingStartAt: Date.now() - 5000 }));
      tick(room);
      assert.equal(room.state, 'READY_CHECK');
    });

    it('nudges only once per incident', () => {
      const room = twoViewers(makeRoom({ state: 'SEEKING', wasPlayingBeforeInterruption: true, bufferingStartAt: longAgo(), forcedResumeAttempted: true }));
      tick(room);
      assert.equal(room.state, 'SEEKING');
    });

    it('nudges a lone single-player device that never reaches the threshold', () => {
      const room = makeRoom({ state: 'READY_CHECK', singlePlayer: true, bufferingStartAt: longAgo() });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 1 }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });

    it('starts the clock when a room enters a waiting state', () => {
      const room = makeRoom({ state: 'PLAYING', bufferingStartAt: undefined });
      handleUserAction(room, 'v1', 'SEEK', 500);
      assert.equal(room.state, 'SEEKING');
      assert.ok(room.bufferingStartAt !== undefined);
    });

    it('restarts the clock for a second seek during SEEKING', () => {
      const room = makeRoom({ state: 'SEEKING', bufferingStartAt: longAgo() });
      handleUserAction(room, 'v1', 'SEEK', 500);
      assert.ok(Date.now() - room.bufferingStartAt! < 1000);
    });
  });

  describe('Watching again after the end', () => {
    it('resumes playback once a seek from ENDED settles', () => {
      const room = makeRoom({ state: 'ENDED' });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 15 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 15 }));
      handleUserAction(room, 'v1', 'SEEK', 0);
      assert.equal(room.state, 'SEEKING');
      const result = tick(room);
      assert.equal(room.state, 'PLAYING');
      assert.ok(result.dispatches.some(d => d.message.type === 'PLAY_AT'));
    });
  });

  describe('Browser blocked playback', () => {
    it('holds the room in BUFFERING until the viewer taps to start', () => {
      const room = makeRoom({ state: 'PLAYING' });
      addViewer(room, makeViewer('v1', true, { paused: false, mediaTime: 50, bufferedAhead: 60 }));
      addViewer(room, makeViewer('v2', false, { paused: true, mediaTime: 50, bufferedAhead: 60, playbackBlocked: true }));
      tick(room);
      assert.equal(room.state, 'BUFFERING');
    });

    it('does not resume while a viewer is still blocked', () => {
      const room = makeRoom({ state: 'BUFFERING', bufferingStartAt: Date.now() });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 60 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 60, playbackBlocked: true }));
      tick(room);
      assert.equal(room.state, 'BUFFERING');
    });

    it('resumes once the viewer has tapped', () => {
      const room = makeRoom({ state: 'BUFFERING', bufferingStartAt: Date.now() });
      addViewer(room, makeViewer('v1', true, { bufferedAhead: 60 }));
      addViewer(room, makeViewer('v2', false, { bufferedAhead: 60, playbackBlocked: false }));
      tick(room);
      assert.equal(room.state, 'PLAYING');
    });
  });

  describe('Drift correction', () => {
    it('does not rewind the room when a freshly reconnected viewer still reports 0:00', () => {
      const room = makeRoom({ state: 'PLAYING', canonicalTime: 4102.8 });
      addViewer(room, makeViewer('host', true, { mediaTime: 4102.8, bufferedAhead: 60, paused: false }));
      const reconnected = makeViewer('peer', false, { mediaTime: 0, bufferedAhead: 30, paused: false });
      reconnected.joinedAt = Date.now() - 500;
      addViewer(room, reconnected);

      const result = tick(room);

      assert.equal(room.state, 'PLAYING');
      assert.equal(result.dispatches.some(d => d.message.type === 'SEEK'), false);
    });

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

    it('decays adaptiveResumeThreshold toward the configured base after a long stable stretch', () => {
      const room = makeRoom({ state: 'PLAYING', lastPlayStartAt: Date.now() - 120_000 });
      room.adaptiveResumeThreshold = 12;
      addViewer(room, makeViewer('v1', true, { mediaTime: 100.0, bufferedAhead: 15, paused: false }));
      addViewer(room, makeViewer('v2', false, { mediaTime: 106.0, bufferedAhead: 12, paused: false }));
      tick(room);
      assert.equal(room.state, 'RESYNCING');
      assert.ok(room.adaptiveResumeThreshold < 12);
      assert.ok(room.adaptiveResumeThreshold >= config.bufferResumeThreshold);
    });
  });
});
