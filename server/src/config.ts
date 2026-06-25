import path from 'path';
import { readPersistedConfig } from './persistedConfig';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), '..', 'data');

// Load persisted config (written by onboarding UI). Env vars take precedence
// so Docker deployments can override without touching the UI.
const persisted = readPersistedConfig();

function get(key: string, fallback: string): string {
  return process.env[key] ?? (persisted as Record<string, string>)[key] ?? fallback;
}

function getInt(key: string, fallback: number): number {
  const val = process.env[key] ?? (persisted as Record<string, string>)[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

export const config = {
  port: getInt('PORT', 3000),
  host: get('HOST', '0.0.0.0'),
  baseUrl: get('APP_BASE_URL', 'http://localhost:3000'),
  uploadUrl: get('UPLOAD_URL', ''),
  openSubtitlesApiKey: get('OPENSUBTITLES_API_KEY', ''),
  subtitleLang: get('SUBTITLE_LANG', 'en'),
  mediaDir: get('MEDIA_DIR', path.join(DATA_DIR, 'media')),
  dbPath: get('DB_PATH', path.join(DATA_DIR, 'app.db')),
  maxUploadBytes: getInt('MAX_UPLOAD_BYTES', 10 * 1024 * 1024 * 1024),
  roomTtlHours: getInt('ROOM_TTL_HOURS', 24),
  isDev: get('NODE_ENV', 'development') !== 'production',
  bufferPauseThreshold: 1,        // pause proactively when bufferedAhead drops below 1s
  bufferResumeThreshold: 1.5,     // base resume threshold (adaptive, can grow to max)
  bufferResumeThresholdMax: 6,    // adaptive cap — won't wait more than 6s ever
  bufferQuickStallMs: 12_000,     // re-stall within 12s of resuming → raise threshold
  bufferStableMs: 25_000,         // stable play for 25s → decay threshold toward base
  driftIgnoreThreshold: 0.25,
  driftRateThreshold: 5,          // resync for drift > 5s (was 10)
  playbackRateSlow: 0.95,         // more aggressive nudge (was 0.97)
  playbackRateFast: 1.05,         // more aggressive nudge (was 1.03)
  heartbeatStaleMs: 3000,         // stale after 3s (was 5s)
  playAtLookaheadMs: 800,         // 800ms lead time (was 3000ms)
  passwordHash: get('PASSWORD_HASH', ''),
  sessionSecret: get('SESSION_SECRET', ''),
} as const;
