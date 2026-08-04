import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { hasSubtitles, isFetching } from './subtitles';
import { getTranscodeStatus } from './ffmpeg';
import type { RoomRow, LibraryMetaRow, LibraryFileInfo, MarathonRow, MarathonItemRow, MarathonSummary, MarathonItemDetail, WatchHistoryRow } from './types';

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;

  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });

  _db = new DatabaseSync(config.dbPath);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id             TEXT PRIMARY KEY,
      token          TEXT UNIQUE NOT NULL,
      media_path     TEXT NOT NULL,
      media_filename TEXT NOT NULL,
      media_size     INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_meta (
      filename       TEXT PRIMARY KEY,
      duration       REAL NOT NULL DEFAULT 0,
      last_time      REAL NOT NULL DEFAULT 0,
      last_played_at INTEGER NOT NULL DEFAULT 0,
      thumb_ready    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS marathons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marathon_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      marathon_id       INTEGER NOT NULL,
      position          INTEGER NOT NULL,
      title             TEXT NOT NULL,
      library_filename  TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marathon_reviews (
      item_id    INTEGER NOT NULL,
      viewer     TEXT NOT NULL,
      score      REAL,
      note       TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_id, viewer)
    );

    CREATE TABLE IF NOT EXISTS watch_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      hls_dir_name  TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      detected_at   TEXT NOT NULL,
      dismissed     INTEGER NOT NULL DEFAULT 0
    );

    -- Durable log of "a watch session started for this file" — unlike the
    -- rooms table (purged once a room expires, since its only job is
    -- generating a short-lived shareable link), rows here are permanent,
    -- so watch counts/dates survive long after the room itself is gone.
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      media_filename TEXT NOT NULL,
      started_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_token   ON rooms(token);
    CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);
    CREATE INDEX IF NOT EXISTS idx_marathon_items_marathon ON marathon_items(marathon_id);
    CREATE INDEX IF NOT EXISTS idx_marathon_reviews_item ON marathon_reviews(item_id);
    CREATE INDEX IF NOT EXISTS idx_watch_sessions_filename ON watch_sessions(media_filename);
  `);

  try { _db.exec('ALTER TABLE library_meta ADD COLUMN subtitle_name TEXT DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE marathon_items ADD COLUMN poster_path TEXT DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE marathon_items ADD COLUMN tmdb_id INTEGER DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE library_meta ADD COLUMN poster_path TEXT DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE library_meta ADD COLUMN tmdb_id INTEGER DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE marathon_items ADD COLUMN watch_history_id INTEGER DEFAULT NULL'); } catch {}
  try { _db.exec('ALTER TABLE library_meta ADD COLUMN display_title TEXT DEFAULT NULL'); } catch {}

  // One-time backfill: watch_history titles were originally stored as the
  // raw .hls directory name (junk tokens, dots instead of spaces) — clean
  // any still in that form. Idempotent (re-cleaning an already-clean title
  // is a no-op), cheap (small table), safe to run on every startup.
  try {
    const rows = _db.prepare('SELECT id, title FROM watch_history').all() as unknown as { id: number; title: string }[];
    const update = _db.prepare('UPDATE watch_history SET title = ? WHERE id = ?');
    for (const row of rows) {
      const cleaned = cleanTitleForDisplay(row.title);
      if (cleaned && cleaned !== row.title) update.run(cleaned, row.id);
    }
  } catch { /* best-effort backfill, never block startup over it */ }

  return _db;
}

// ── Rooms ─────────────────────────────────────────────────────────────────────

export function createRoom(room: RoomRow): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO rooms (id, token, media_path, media_filename, media_size, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(room.id, room.token, room.media_path, room.media_filename, room.media_size, room.created_at, room.expires_at);
}

export function getRoomByToken(token: string): RoomRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM rooms WHERE token = ?').get(token) as unknown as RoomRow | undefined;
}

export function purgeExpiredRooms(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM rooms WHERE expires_at < ?').run(now);
}

// ── Library metadata ──────────────────────────────────────────────────────────

export function upsertLibraryMeta(filename: string, duration: number, thumbReady: boolean): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO library_meta (filename, duration, last_time, last_played_at, thumb_ready)
    VALUES (?, ?, 0, 0, ?)
    ON CONFLICT(filename) DO UPDATE SET
      duration   = excluded.duration,
      thumb_ready = excluded.thumb_ready
  `).run(filename, duration, thumbReady ? 1 : 0);
}

export function updateLibraryLastTime(filename: string, lastTime: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO library_meta (filename, duration, last_time, last_played_at, thumb_ready)
    VALUES (?, 0, ?, ?, 0)
    ON CONFLICT(filename) DO UPDATE SET
      last_time      = excluded.last_time,
      last_played_at = excluded.last_played_at
  `).run(filename, lastTime, Date.now());
}

export function getLibraryMeta(filename: string): LibraryMetaRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM library_meta WHERE filename = ?').get(filename) as unknown as LibraryMetaRow | undefined;
}

export function setSubtitleName(filename: string, name: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO library_meta (filename, duration, last_time, last_played_at, thumb_ready, subtitle_name)
    VALUES (?, 0, 0, 0, 0, ?)
    ON CONFLICT(filename) DO UPDATE SET subtitle_name = excluded.subtitle_name
  `).run(filename, name);
}

export function deleteLibraryMeta(filename: string): void {
  const db = getDb();
  db.prepare('DELETE FROM library_meta WHERE filename = ?').run(filename);
}

export function renameLibraryFile(oldFilename: string, newFilename: string, oldPath: string, newPath: string): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO library_meta (filename, duration, last_time, last_played_at, thumb_ready, subtitle_name, poster_path, tmdb_id, display_title)
      SELECT ?, duration, last_time, last_played_at, thumb_ready, subtitle_name, poster_path, tmdb_id, display_title FROM library_meta WHERE filename = ?
    `).run(newFilename, oldFilename);
    db.prepare('DELETE FROM library_meta WHERE filename = ?').run(oldFilename);
    db.prepare(`UPDATE rooms SET media_path = ?, media_filename = ? WHERE media_filename = ?`)
      .run(newPath, newFilename, oldFilename);
    // Watch session history is keyed by filename too — a rename shouldn't
    // orphan it from its "watched N times" count, same reasoning as
    // carrying poster_path/tmdb_id/display_title through above.
    db.prepare('UPDATE watch_sessions SET media_filename = ? WHERE media_filename = ?')
      .run(newFilename, oldFilename);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// displayTitle is optional — when omitted (the PATCH route's case, which
// only ever sets posterPath/tmdbId), COALESCE keeps whatever display_title
// is already there instead of blanking it.
export function updateLibraryPoster(filename: string, posterPath: string | null, tmdbId: number | null, displayTitle?: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO library_meta (filename, duration, last_time, last_played_at, thumb_ready, poster_path, tmdb_id, display_title)
    VALUES (?, 0, 0, 0, 0, ?, ?, ?)
    ON CONFLICT(filename) DO UPDATE SET
      poster_path = excluded.poster_path,
      tmdb_id = excluded.tmdb_id,
      display_title = COALESCE(excluded.display_title, library_meta.display_title)
  `).run(filename, posterPath, tmdbId, displayTitle ?? null);
}

// ── Library file listing ──────────────────────────────────────────────────────

export function listLibraryFiles(): LibraryFileInfo[] {
  const libraryDir = path.join(config.mediaDir, 'library');
  if (!fs.existsSync(libraryDir)) return [];

  const db = getDb();
  const files = fs.readdirSync(libraryDir)
    .filter(f => f.toLowerCase().endsWith('.mp4'));

  const allMeta = new Map(
    (db.prepare('SELECT * FROM library_meta').all() as unknown as Array<LibraryMetaRow & { subtitle_name?: string | null; poster_path?: string | null; tmdb_id?: number | null; display_title?: string | null }>)
      .map(r => [r.filename, r])
  );

  return files.map(filename => {
    const stat = fs.statSync(path.join(libraryDir, filename));
    const meta = allMeta.get(filename) as unknown as (LibraryMetaRow & { subtitle_name?: string | null; poster_path?: string | null; tmdb_id?: number | null; display_title?: string | null }) | undefined;

    const fullPath = path.join(libraryDir, filename);
    const hasSub = hasSubtitles(fullPath);
    let subtitleName = meta?.subtitle_name ?? null;
    if (hasSub && !subtitleName) {
      subtitleName = filename.replace(/\.mp4$/i, '');
      setSubtitleName(filename, subtitleName);
    }
    return {
      filename,
      size: stat.size,
      duration: meta?.duration ?? 0,
      lastTime: meta?.last_time ?? 0,
      lastPlayedAt: meta?.last_played_at ?? 0,
      thumbReady: (meta?.thumb_ready ?? 0) === 1,
      thumbUrl: `/api/library/${encodeURIComponent(filename)}/thumb`,
      posterPath: meta?.poster_path ?? null,
      displayTitle: meta?.display_title ?? null,
      hasSubtitles: hasSub,
      subtitleFetching: isFetching(fullPath),
      subtitleName,
      transcodeStatus: getTranscodeStatus(fullPath),
    };
  }).sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || a.filename.localeCompare(b.filename));
}

// ── Marathons ────────────────────────────────────────────────────────────────

export function createMarathon(name: string): MarathonRow {
  const db = getDb();
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM marathons').get() as { next: number }).next;
  const created_at = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO marathons (name, position, created_at) VALUES (?, ?, ?)'
  ).run(name, position, created_at);
  return { id: Number(result.lastInsertRowid), name, position, created_at };
}

export function listMarathons(): MarathonSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      m.id, m.name, m.position,
      COUNT(mi.id) AS itemCount,
      SUM(CASE WHEN mi.status = 'done' THEN 1 ELSE 0 END) AS doneCount
    FROM marathons m
    LEFT JOIN marathon_items mi ON mi.marathon_id = m.id
    GROUP BY m.id
    ORDER BY m.position ASC
  `).all() as unknown as { id: number; name: string; position: number; itemCount: number; doneCount: number | null }[];
  return rows.map(r => ({ id: r.id, name: r.name, position: r.position, itemCount: r.itemCount, doneCount: r.doneCount ?? 0 }));
}

export function getMarathon(id: number): MarathonRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM marathons WHERE id = ?').get(id) as unknown as MarathonRow | undefined;
}

export function renameMarathon(id: number, name: string): void {
  const db = getDb();
  db.prepare('UPDATE marathons SET name = ? WHERE id = ?').run(name, id);
}

export function deleteMarathon(id: number): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM marathon_reviews WHERE item_id IN (SELECT id FROM marathon_items WHERE marathon_id = ?)').run(id);
    db.prepare('DELETE FROM marathon_items WHERE marathon_id = ?').run(id);
    db.prepare('DELETE FROM marathons WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listMarathonItems(marathonId: number): MarathonItemDetail[] {
  const db = getDb();
  const items = db.prepare(
    'SELECT * FROM marathon_items WHERE marathon_id = ? ORDER BY position ASC'
  ).all(marathonId) as unknown as MarathonItemRow[];
  const reviews = db.prepare(
    'SELECT * FROM marathon_reviews WHERE item_id IN (SELECT id FROM marathon_items WHERE marathon_id = ?)'
  ).all(marathonId) as unknown as { item_id: number; viewer: string; score: number | null; note: string | null }[];
  return items.map(item => ({
    id: item.id,
    position: item.position,
    title: item.title,
    libraryFilename: item.library_filename,
    status: item.status,
    posterPath: item.poster_path,
    tmdbId: item.tmdb_id,
    reviews: reviews
      .filter(r => r.item_id === item.id)
      .map(r => ({ viewer: r.viewer as 'user' | 'partner', score: r.score, note: r.note })),
  }));
}

export function addMarathonItem(marathonId: number, title: string, libraryFilename: string | null, watchHistoryId: number | null = null): MarathonItemRow {
  const db = getDb();
  const position = (db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM marathon_items WHERE marathon_id = ?'
  ).get(marathonId) as { next: number }).next;
  const created_at = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO marathon_items (marathon_id, position, title, library_filename, status, created_at, poster_path, tmdb_id, watch_history_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(marathonId, position, title, libraryFilename, 'pending', created_at, null, null, watchHistoryId);
  return {
    id: Number(result.lastInsertRowid), marathon_id: marathonId, position, title, library_filename: libraryFilename,
    status: 'pending', created_at, poster_path: null, tmdb_id: null, watch_history_id: watchHistoryId,
  };
}

export function getMarathonItemByWatchHistory(marathonId: number, watchHistoryId: number): MarathonItemRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM marathon_items WHERE marathon_id = ? AND watch_history_id = ?')
    .get(marathonId, watchHistoryId) as unknown as MarathonItemRow | undefined;
}

export function listMarathonsForWatchHistoryEntry(watchHistoryId: number): { marathonId: number; marathonName: string }[] {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT m.id AS marathonId, m.name AS marathonName
    FROM marathon_items mi
    JOIN marathons m ON m.id = mi.marathon_id
    WHERE mi.watch_history_id = ?
    ORDER BY m.name ASC
  `).all(watchHistoryId) as unknown as { marathonId: number; marathonName: string }[];
}

export function getMarathonItem(id: number): MarathonItemRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM marathon_items WHERE id = ?').get(id) as unknown as MarathonItemRow | undefined;
}

export function updateMarathonItem(id: number, fields: { title?: string; libraryFilename?: string | null; status?: 'pending' | 'done' | 'skipped' }): void {
  const db = getDb();
  const current = getMarathonItem(id);
  if (!current) return;
  const title = fields.title ?? current.title;
  const libraryFilename = fields.libraryFilename !== undefined ? fields.libraryFilename : current.library_filename;
  const status = fields.status ?? current.status;
  db.prepare('UPDATE marathon_items SET title = ?, library_filename = ?, status = ? WHERE id = ?')
    .run(title, libraryFilename, status, id);
}

export function deleteMarathonItem(id: number): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM marathon_reviews WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM marathon_items WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function moveMarathonItem(marathonId: number, itemId: number, direction: 'up' | 'down'): void {
  const db = getDb();
  const items = db.prepare(
    'SELECT id, position FROM marathon_items WHERE marathon_id = ? ORDER BY position ASC'
  ).all(marathonId) as unknown as { id: number; position: number }[];
  const index = items.findIndex(i => i.id === itemId);
  if (index === -1) return;
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= items.length) return;
  const a = items[index];
  const b = items[swapIndex];
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE marathon_items SET position = ? WHERE id = ?').run(b.position, a.id);
    db.prepare('UPDATE marathon_items SET position = ? WHERE id = ?').run(a.position, b.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function upsertMarathonReview(itemId: number, viewer: 'user' | 'partner', score: number | null, note: string | null): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  db.prepare(`
    INSERT INTO marathon_reviews (item_id, viewer, score, note, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(item_id, viewer) DO UPDATE SET
      score = excluded.score,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(itemId, viewer, score, note, updated_at);
}

export function moveMarathonItemToPosition(marathonId: number, itemId: number, newPosition: number): void {
  const db = getDb();
  const items = db.prepare(
    'SELECT id FROM marathon_items WHERE marathon_id = ? ORDER BY position ASC'
  ).all(marathonId) as unknown as { id: number }[];
  const fromIndex = items.findIndex(i => i.id === itemId);
  if (fromIndex === -1) return;
  const clamped = Math.max(0, Math.min(newPosition, items.length - 1));
  if (clamped === fromIndex) return;

  const [moved] = items.splice(fromIndex, 1);
  items.splice(clamped, 0, moved);

  db.exec('BEGIN');
  try {
    items.forEach((item, index) => {
      db.prepare('UPDATE marathon_items SET position = ? WHERE id = ?').run(index, item.id);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateMarathonItemPoster(itemId: number, posterPath: string | null, tmdbId: number | null): void {
  const db = getDb();
  db.prepare('UPDATE marathon_items SET poster_path = ?, tmdb_id = ? WHERE id = ?').run(posterPath, tmdbId, itemId);
}

export function listUntrackedItemTitles(): { marathonId: number; marathonName: string; itemId: number; itemTitle: string }[] {
  const db = getDb();
  return db.prepare(`
    SELECT m.id AS marathonId, m.name AS marathonName, mi.id AS itemId, mi.title AS itemTitle
    FROM marathon_items mi
    JOIN marathons m ON m.id = mi.marathon_id
    WHERE mi.library_filename IS NULL
  `).all() as unknown as { marathonId: number; marathonName: string; itemId: number; itemTitle: string }[];
}

// Same idea as the client's cleanLibraryDisplayName: strips release-quality/
// codec/year junk and title-cases what's left, keeping real casing/spacing
// instead of normalizing to a lowercase match key like cleanTitleToken does.
const DISPLAY_JUNK_RE =
  /^(19|20)\d{2}$|^\d{3,4}p$|^(2160p|4k|bluray|blu-ray|webrip|web-?dl|hdrip|dvdrip|dvdscr|x264|x265|h264|h265|hevc|10bit|8bit|ddp?5?1?|dts|aac\d?|ac3|atmos|remux|proper|repack|extended|remastered|uncut|unrated|yify|yts|directors?cut)$/i;

export function cleanTitleForDisplay(raw: string): string {
  const withoutExt = raw.replace(/\.[a-z0-9]+$/i, '');
  const segments = withoutExt.split('.').filter(Boolean);
  const titleSegments: string[] = [];
  for (const seg of segments) {
    if (DISPLAY_JUNK_RE.test(seg)) break;
    titleSegments.push(seg);
  }
  const words = (titleSegments.length ? titleSegments : segments).join(' ').split(/[\s_-]+/).filter(Boolean);
  return words.map(w => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// ── Watch history (derived from orphaned HLS caches) ───────────────────
export function scanForOrphanedHlsEntries(): { hlsDirName: string; title: string; detectedAtMs: number }[] {
  const libraryDir = path.join(config.mediaDir, 'library');
  if (!fs.existsSync(libraryDir)) return [];
  const entries = fs.readdirSync(libraryDir, { withFileTypes: true });
  const mp4Basenames = new Set(
    entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mp4'))
      .map(e => e.name.replace(/\.mp4$/i, ''))
  );
  return entries
    .filter(e => e.isDirectory() && e.name.toLowerCase().endsWith('.hls'))
    .map(e => ({ hlsDirName: e.name, rawTitle: e.name.replace(/\.hls$/i, '') }))
    .filter(({ rawTitle }) => !mp4Basenames.has(rawTitle))
    .map(({ hlsDirName, rawTitle }) => ({
      hlsDirName,
      title: cleanTitleForDisplay(rawTitle),
      detectedAtMs: fs.statSync(path.join(libraryDir, hlsDirName)).mtimeMs,
    }));
}

export function recordWatchHistoryEntries(entries: { hlsDirName: string; title: string; detectedAtMs: number }[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO watch_history (hls_dir_name, title, detected_at, dismissed)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(hls_dir_name) DO NOTHING
  `);
  for (const entry of entries) {
    stmt.run(entry.hlsDirName, entry.title, new Date(entry.detectedAtMs).toISOString());
  }
}

export function listWatchHistory(): WatchHistoryRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM watch_history WHERE dismissed = 0 ORDER BY detected_at DESC'
  ).all() as unknown as WatchHistoryRow[];
}

export function dismissWatchHistoryEntry(id: number): void {
  const db = getDb();
  db.prepare('UPDATE watch_history SET dismissed = 1 WHERE id = ?').run(id);
}

// ── Watch sessions (durable log, unlike the ephemeral rooms table) ─────
export function recordWatchSession(mediaFilename: string): void {
  const db = getDb();
  db.prepare('INSERT INTO watch_sessions (media_filename, started_at) VALUES (?, ?)').run(mediaFilename, Date.now());
}

export function getWatchSessionStats(mediaFilename: string): { count: number; firstAt: string | null; lastAt: string | null } {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS count, MIN(started_at) AS firstAt, MAX(started_at) AS lastAt FROM watch_sessions WHERE media_filename = ?'
  ).get(mediaFilename) as { count: number; firstAt: number | null; lastAt: number | null };
  return {
    count: row.count,
    firstAt: row.firstAt != null ? new Date(row.firstAt).toISOString() : null,
    lastAt: row.lastAt != null ? new Date(row.lastAt).toISOString() : null,
  };
}
