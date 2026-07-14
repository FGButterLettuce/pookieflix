import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from './config';

// ── Transcode tracking ───────────────────────────────────────────────────────
// Manual view/cancel/restart/pause controls (deferred feature, see repo issue
// #13) need visibility into in-progress HLS generation, which fire-and-forget
// generateHLSAsync previously had none of.

export type TranscodeState = 'none' | 'running' | 'paused' | 'complete';

interface TranscodeJob {
  proc: ChildProcess;
  paused: boolean;
  startedAt: number;
}

const activeTranscodes = new Map<string, TranscodeJob>();

export function getTranscodeStatus(videoPath: string): TranscodeState {
  const job = activeTranscodes.get(videoPath);
  if (job) return job.paused ? 'paused' : 'running';
  return hasHLS(videoPath) ? 'complete' : 'none';
}

// Kills an in-progress transcode and removes its partial output, same cleanup
// path as a failed/timed-out transcode already used.
export function cancelTranscode(videoPath: string): boolean {
  const job = activeTranscodes.get(videoPath);
  if (!job) return false;
  job.proc.kill('SIGKILL');
  activeTranscodes.delete(videoPath);
  try { fs.rmSync(hlsDir(videoPath), { recursive: true }); } catch { /* ignore */ }
  return true;
}

// SIGSTOP/SIGCONT freeze and thaw the OS process without losing any progress
// - ffmpeg's -c copy stream-copy has no in-memory state that needs flushing,
// it just stops consuming CPU/IO until resumed.
export function pauseTranscode(videoPath: string): boolean {
  const job = activeTranscodes.get(videoPath);
  if (!job || job.paused) return false;
  job.proc.kill('SIGSTOP');
  job.paused = true;
  return true;
}

export function resumeTranscode(videoPath: string): boolean {
  const job = activeTranscodes.get(videoPath);
  if (!job || !job.paused) return false;
  job.proc.kill('SIGCONT');
  job.paused = false;
  return true;
}

// Cancels any in-progress job (if running) and clears any existing (complete
// or partial) output, then kicks off a fresh transcode from scratch.
export function restartTranscode(videoPath: string): void {
  cancelTranscode(videoPath);
  try { fs.rmSync(hlsDir(videoPath), { recursive: true }); } catch { /* ignore */ }
  generateHLSAsync(videoPath);
}

function thumbsDir(): string {
  const dir = path.join(config.mediaDir, 'library', '.thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function thumbPath(filename: string): string {
  return path.join(thumbsDir(), filename.replace(/\.mp4$/i, '.jpg'));
}

export async function extractMetadata(videoPath: string): Promise<{ duration: number }> {
  return new Promise(resolve => {
    const ff = spawn('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let out = '';
    ff.stdout.on('data', d => { out += d.toString(); });
    ff.on('close', () => {
      const duration = parseFloat(out.trim());
      resolve({ duration: isNaN(duration) ? 0 : duration });
    });
    ff.on('error', () => resolve({ duration: 0 }));
  });
}

export async function generateThumbnail(videoPath: string, filename: string): Promise<boolean> {
  const outPath = thumbPath(filename);
  const { duration } = await extractMetadata(videoPath);

  // Seek to 10% or up to 30s, but never past the end
  const seekTo = Math.min(duration > 0 ? duration * 0.9 : 0, Math.min(30, Math.max(1, duration * 0.1)));

  return new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-ss', String(seekTo),
      '-i', videoPath,
      '-vf', 'thumbnail=n=30,scale=480:-1',
      '-frames:v', '1',
      '-q:v', '4',
      outPath,
      '-y',
    ]);
    ff.on('close', code => resolve(code === 0));
    ff.on('error', () => resolve(false));
  });
}

// Kick off in background, don't await
export function generateThumbnailAsync(videoPath: string, filename: string, onDone?: (ok: boolean) => void): void {
  generateThumbnail(videoPath, filename)
    .then(ok => onDone?.(ok))
    .catch(() => onDone?.(false));
}

// Move moov atom to front of file so iOS can start buffering without a second range request.
// Writes to a temp file then atomically replaces the original.
export async function applyFastStart(videoPath: string): Promise<void> {
  const tmp = videoPath + '.faststart.tmp';
  const ok = await new Promise<boolean>(resolve => {
    const ff = spawn('ffmpeg', [
      '-i', videoPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', tmp,
    ]);
    ff.on('close', code => resolve(code === 0));
    ff.on('error', () => resolve(false));
  });
  if (ok) {
    fs.renameSync(tmp, videoPath);
  } else {
    try { fs.rmSync(tmp); } catch { /* ignore */ }
  }
}

// ── HLS ───────────────────────────────────────────────────────────────────────

export function hlsDir(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, '.hls');
}

export function hlsManifestPath(videoPath: string): string {
  return path.join(hlsDir(videoPath), 'index.m3u8');
}

export function hasHLS(videoPath: string): boolean {
  return fs.existsSync(hlsManifestPath(videoPath));
}

// Segment video into HLS chunks (copy, no re-encode). Runs async — call and forget.
const HLS_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — stream copy should never take longer

export async function generateHLS(videoPath: string): Promise<boolean> {
  if (hasHLS(videoPath)) return true;
  if (activeTranscodes.has(videoPath)) return false; // already in progress
  const dir = hlsDir(videoPath);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = hlsManifestPath(videoPath);
  const ok = await new Promise<boolean>(resolve => {
    const ff = spawn('ffmpeg', [
      '-fflags', '+genpts',
      '-err_detect', 'ignore_err',
      '-i', videoPath,
      '-c', 'copy',
      '-hls_time', '4',
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg%04d.ts'),
      '-y', manifest,
    ]);
    activeTranscodes.set(videoPath, { proc: ff, paused: false, startedAt: Date.now() });
    // Only clear the registry entry if it's still this exact process — a
    // cancelled-then-immediately-restarted job registers a new process under
    // the same videoPath key, and this stale handler firing later must not
    // delete that newer entry out from under it.
    const clearIfCurrent = () => {
      if (activeTranscodes.get(videoPath)?.proc === ff) activeTranscodes.delete(videoPath);
    };
    const timer = setTimeout(() => { try { ff.kill(); } catch {} resolve(false); }, HLS_TIMEOUT_MS);
    ff.on('close', code => { clearTimeout(timer); clearIfCurrent(); resolve(code === 0); });
    ff.on('error', () => { clearTimeout(timer); clearIfCurrent(); resolve(false); });
  });
  // Only clean up this call's own output. If a newer transcode has already
  // taken over this videoPath (e.g. a restart's fresh job registered before
  // this killed process's own close/error event got around to firing), the
  // registry entry now points at a different process, and deleting `dir`
  // here would destroy that newer job's in-progress files.
  const supersededByNewer = activeTranscodes.has(videoPath);
  if (!ok && !supersededByNewer) {
    try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  return ok;
}

export function generateHLSAsync(videoPath: string): void {
  generateHLS(videoPath).catch(() => {});
}
