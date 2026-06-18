import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from './config';

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
