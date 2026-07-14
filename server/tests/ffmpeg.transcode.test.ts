import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('manual transcode controls', () => {
  let dataDir: string;
  let shortVideo: string; // 2s — fast happy-path checks
  let longVideo: string;  // 12s — enough real work to reliably cancel/pause mid-flight
  let ffmpeg: typeof import('../src/ffmpeg');

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-transcode-test-'));
    process.env.DATA_DIR = dataDir;
    ffmpeg = await import('../src/ffmpeg');

    shortVideo = path.join(dataDir, 'short.mp4');
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=duration=2',
      '-c:v', 'libx264', '-c:a', 'aac', '-y', shortVideo,
    ]);

    longVideo = path.join(dataDir, 'long.mp4');
    spawnSync('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=duration=12',
      '-c:v', 'libx264', '-c:a', 'aac', '-y', longVideo,
    ]);

    assert.ok(fs.existsSync(shortVideo), 'test fixture (short) failed to generate — is ffmpeg installed?');
    assert.ok(fs.existsSync(longVideo), 'test fixture (long) failed to generate — is ffmpeg installed?');
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports none before transcoding and complete after, with a valid VOD manifest', async () => {
    assert.equal(ffmpeg.getTranscodeStatus(shortVideo), 'none');
    const ok = await ffmpeg.generateHLS(shortVideo);
    assert.equal(ok, true);
    assert.equal(ffmpeg.getTranscodeStatus(shortVideo), 'complete');

    const manifest = fs.readFileSync(ffmpeg.hlsManifestPath(shortVideo), 'utf8');
    assert.match(manifest, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(manifest, /#EXT-X-ENDLIST/);
  });

  it('cancel/pause/resume on a file with no active job all return false', () => {
    assert.equal(ffmpeg.cancelTranscode(longVideo), false);
    assert.equal(ffmpeg.pauseTranscode(longVideo), false);
    assert.equal(ffmpeg.resumeTranscode(longVideo), false);
  });

  it('cancelTranscode kills an in-progress job and cleans up its output', async () => {
    ffmpeg.generateHLSAsync(longVideo);
    // generateHLS's synchronous prefix (through activeTranscodes.set) runs
    // before this line, since `new Promise(executor)` runs its executor
    // synchronously — the job is registered before generateHLSAsync returns.
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'running');

    const cancelled = ffmpeg.cancelTranscode(longVideo);
    assert.equal(cancelled, true);
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'none');
    assert.equal(fs.existsSync(ffmpeg.hlsDir(longVideo)), false);

    // Give the killed process's own close handler a moment to fire and
    // confirm it does NOT resurrect the (already-deleted) directory.
    await new Promise(r => setTimeout(r, 300));
    assert.equal(fs.existsSync(ffmpeg.hlsDir(longVideo)), false);
  });

  it('pauseTranscode then resumeTranscode round-trips status without losing the job', async () => {
    ffmpeg.generateHLSAsync(longVideo);
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'running');

    assert.equal(ffmpeg.pauseTranscode(longVideo), true);
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'paused');
    // Pausing again while already paused is a no-op, not a second pause.
    assert.equal(ffmpeg.pauseTranscode(longVideo), false);

    assert.equal(ffmpeg.resumeTranscode(longVideo), true);
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'running');
    assert.equal(ffmpeg.resumeTranscode(longVideo), false);

    // Let it finish for real rather than leaving a dangling process.
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'complete');
  });

  it('restartTranscode cancels the in-progress job, clears output, and starts fresh', async () => {
    // Reset to a clean 'none' state for this test regardless of prior tests
    // (the previous test left longVideo 'complete').
    ffmpeg.cancelTranscode(longVideo);
    try { fs.rmSync(ffmpeg.hlsDir(longVideo), { recursive: true }); } catch { /* ignore */ }
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'none');

    ffmpeg.generateHLSAsync(longVideo);
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'running');

    ffmpeg.restartTranscode(longVideo);
    // restartTranscode cancels the old job synchronously, then kicks off a
    // new one — still 'running' (or momentarily 'none' between the two),
    // never left permanently stuck.
    assert.notEqual(ffmpeg.getTranscodeStatus(longVideo), 'paused');

    await new Promise(r => setTimeout(r, 2500));
    assert.equal(ffmpeg.getTranscodeStatus(longVideo), 'complete');
    const manifest = fs.readFileSync(ffmpeg.hlsManifestPath(longVideo), 'utf8');
    assert.match(manifest, /#EXT-X-ENDLIST/);
  });
});
