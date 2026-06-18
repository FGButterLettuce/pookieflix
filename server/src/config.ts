import path from 'path';

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function getEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

const DATA_DIR = getEnv('DATA_DIR', path.resolve(process.cwd(), '..', 'data'));

export const config = {
  port: getEnvInt('PORT', 3000),
  host: getEnv('HOST', '0.0.0.0'),
  baseUrl: getEnv('APP_BASE_URL', 'http://localhost:3000'),
  // Direct upload URL bypasses Cloudflare's 100MB body limit.
  // Set to your LAN address, e.g. http://192.168.0.91:3000
  uploadUrl: getEnv('UPLOAD_URL', ''),
  openSubtitlesApiKey: getEnv('OPENSUBTITLES_API_KEY', 'mm41STzVHZFzW2P4tK4VLlR6N9apAtGE'),
  subtitleLang: getEnv('SUBTITLE_LANG', 'en'),
  mediaDir: getEnv('MEDIA_DIR', path.join(DATA_DIR, 'media')),
  dbPath: getEnv('DB_PATH', path.join(DATA_DIR, 'app.db')),
  maxUploadBytes: getEnvInt('MAX_UPLOAD_BYTES', 10 * 1024 * 1024 * 1024), // 10 GB default
  roomTtlHours: getEnvInt('ROOM_TTL_HOURS', 24),
  isDev: getEnv('NODE_ENV', 'development') !== 'production',
  // Buffer thresholds for sync (seconds)
  bufferPauseThreshold: 0,  // only actual stalls (waiting=true) trigger BUFFERING — preemptive pauses cause seeks that wipe the buffer
  bufferResumeThreshold: 3, // resume when bufferedAhead >= this (or readyState 4)
  // Drift thresholds (seconds)
  driftIgnoreThreshold: 0.25,
  driftRateThreshold: 10,
  // Rate adjustment range
  playbackRateSlow: 0.97,
  playbackRateFast: 1.03,
  // Heartbeat stale threshold (ms)
  heartbeatStaleMs: 5000,
  // PLAY_AT lookahead (ms) — how far ahead wallClockTime is set so clients can seek+buffer before playing
  playAtLookaheadMs: 3000,
} as const;
