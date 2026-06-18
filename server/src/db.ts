import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { hasSubtitles, isFetching } from './subtitles';
import type { RoomRow, LibraryMetaRow, LibraryFileInfo } from './types';

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

    CREATE INDEX IF NOT EXISTS idx_rooms_token   ON rooms(token);
    CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);
  `);

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

export function deleteLibraryMeta(filename: string): void {
  const db = getDb();
  db.prepare('DELETE FROM library_meta WHERE filename = ?').run(filename);
}

export function renameLibraryFile(oldFilename: string, newFilename: string, oldPath: string, newPath: string): void {
  const db = getDb();
  // Rename meta row (filename is the primary key, so insert+delete)
  db.prepare(`
    INSERT INTO library_meta (filename, duration, last_time, last_played_at, thumb_ready)
    SELECT ?, duration, last_time, last_played_at, thumb_ready FROM library_meta WHERE filename = ?
  `).run(newFilename, oldFilename);
  db.prepare('DELETE FROM library_meta WHERE filename = ?').run(oldFilename);
  // Update any existing room records that reference the old file
  db.prepare(`UPDATE rooms SET media_path = ?, media_filename = ? WHERE media_filename = ?`)
    .run(newPath, newFilename, oldFilename);
}

// ── Library file listing ──────────────────────────────────────────────────────

export function listLibraryFiles(): LibraryFileInfo[] {
  const libraryDir = path.join(config.mediaDir, 'library');
  if (!fs.existsSync(libraryDir)) return [];

  const db = getDb();
  const files = fs.readdirSync(libraryDir)
    .filter(f => f.toLowerCase().endsWith('.mp4'));

  return files.map(filename => {
    const stat = fs.statSync(path.join(libraryDir, filename));
    const meta = db.prepare('SELECT * FROM library_meta WHERE filename = ?').get(filename) as unknown as LibraryMetaRow | undefined;

    const fullPath = path.join(libraryDir, filename);
    return {
      filename,
      size: stat.size,
      duration: meta?.duration ?? 0,
      lastTime: meta?.last_time ?? 0,
      lastPlayedAt: meta?.last_played_at ?? 0,
      thumbReady: (meta?.thumb_ready ?? 0) === 1,
      thumbUrl: `/api/library/${encodeURIComponent(filename)}/thumb`,
      hasSubtitles: hasSubtitles(fullPath),
      subtitleFetching: isFetching(fullPath),
    };
  }).sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || a.filename.localeCompare(b.filename));
}
