import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export interface PersistedConfig {
  APP_BASE_URL?: string;
  UPLOAD_URL?: string;
  OPENSUBTITLES_API_KEY?: string;
  TMDB_API_KEY?: string;
  TUNNEL_TOKEN?: string;
  PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  USER_NAME?: string;
  PARTNER_NAME?: string;
  setupComplete?: boolean;
}

export function readPersistedConfig(): PersistedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  // Deliberately not caught: treating a corrupt file as empty would look like
  // "no password set" and open every admin route.
  return JSON.parse(raw) as PersistedConfig;
}

export function writePersistedConfig(data: PersistedConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = readPersistedConfig();
  // Write-then-rename so a crash mid-save can't leave a truncated config.
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ ...existing, ...data }, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function isSetupComplete(): boolean {
  const c = readPersistedConfig();
  return !!(c.setupComplete && c.APP_BASE_URL);
}

// Auth gating must reflect changes made while the server is already running
// (setup wizard, Settings -> Change password) - unlike most other config
// values, these are read fresh on every call rather than cached at boot,
// since a stale in-memory copy would mean a newly-set password never
// actually took effect until the process restarted.
export function getPasswordHash(): string {
  return process.env.PASSWORD_HASH || readPersistedConfig().PASSWORD_HASH || '';
}

export function getSessionSecret(): string {
  return process.env.SESSION_SECRET || readPersistedConfig().SESSION_SECRET || '';
}

// Read fresh for the same reason: a key saved in Settings must work without a restart.
export function getOpenSubtitlesApiKey(): string {
  return process.env.OPENSUBTITLES_API_KEY || readPersistedConfig().OPENSUBTITLES_API_KEY || '';
}
