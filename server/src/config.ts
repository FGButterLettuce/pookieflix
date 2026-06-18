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
  bufferPauseThreshold: 0,
  bufferResumeThreshold: 3,
  driftIgnoreThreshold: 0.25,
  driftRateThreshold: 10,
  playbackRateSlow: 0.97,
  playbackRateFast: 1.03,
  heartbeatStaleMs: 5000,
  playAtLookaheadMs: 3000,
} as const;
