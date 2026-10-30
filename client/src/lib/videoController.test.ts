import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoController } from './videoController';
import type { VideoEvent } from './videoController';

class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  currentTime = 10;
  duration = 100;
  playbackRate = 1;
  error = null;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  playError: Error | null = null;
  async play(): Promise<void> {
    if (this.playError) throw this.playError;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

const blocked = () => Object.assign(new Error('needs a gesture'), { name: 'NotAllowedError' });
const settle = () => new Promise(r => setTimeout(r, 5));

function setup() {
  const video = new FakeVideo();
  const controller = new VideoController(video as unknown as HTMLVideoElement);
  const events: VideoEvent[] = [];
  controller.on(e => events.push(e));
  return { video, controller, events };
}

test('a browser-blocked PLAY_AT is reported in the heartbeat and to the UI', async () => {
  const { video, controller, events } = setup();
  video.playError = blocked();
  controller.schedulePlayAt(10, Date.now() - 1);
  await settle();
  assert.equal(controller.getHeartbeat().playbackBlocked, true);
  assert.ok(events.includes('playbackblocked'));
  controller.destroy();
});

test('a play interrupted by another command is not reported as blocked', async () => {
  const { video, controller, events } = setup();
  video.playError = Object.assign(new Error('interrupted'), { name: 'AbortError' });
  controller.schedulePlayAt(10, Date.now() - 1);
  await settle();
  assert.equal(controller.getHeartbeat().playbackBlocked, false);
  assert.equal(events.includes('playbackblocked'), false);
  controller.destroy();
});

test('the unlock tap clears the block and leaves the video paused for the server to start', async () => {
  const { video, controller, events } = setup();
  video.playError = blocked();
  controller.schedulePlayAt(10, Date.now() - 1);
  await settle();
  video.playError = null;
  await controller.unlockPlayback();
  assert.equal(controller.getHeartbeat().playbackBlocked, false);
  assert.equal(video.paused, true);
  assert.ok(events.includes('playbackunblocked'));
  assert.equal(events.includes('play'), false);
  controller.destroy();
});

test('an unlock tap that is still refused keeps the block', async () => {
  const { video, controller } = setup();
  video.playError = blocked();
  controller.schedulePlayAt(10, Date.now() - 1);
  await settle();
  await controller.unlockPlayback();
  assert.equal(controller.getHeartbeat().playbackBlocked, true);
  controller.destroy();
});

test('heartbeats report end-of-film as fully buffered', () => {
  const { video, controller } = setup();
  video.currentTime = 99;
  video.buffered = { length: 1, start: () => 0, end: () => 100 };
  assert.ok(controller.getHeartbeat().bufferedAhead >= 3600);
  controller.destroy();
});

test('a viewer pressing pause counts as a user pause', () => {
  const { video, controller } = setup();
  video.paused = true;
  assert.equal(controller.isUserPause(), true);
  controller.destroy();
});

test('the pause browsers fire at the end of a film is not a user pause', () => {
  const { video, controller } = setup();
  video.ended = true;
  assert.equal(controller.isUserPause(), false);
  controller.destroy();
});

test('a pause applied from a server command is not a user pause', () => {
  const { video, controller } = setup();
  video.paused = false;
  controller.applyPause(10);
  assert.equal(controller.isUserPause(), false);
  controller.destroy();
});
