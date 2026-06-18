import fs from 'fs';
import { config } from './config';

const OS_API = 'https://api.opensubtitles.com/api/v1';
const UA = 'WatchTogether v1.0';

// Track in-progress fetches to avoid duplicates
const inFlight = new Set<string>();

export function subtitlePath(videoPath: string): string {
  return videoPath + '.vtt';
}

export function hasSubtitles(videoPath: string): boolean {
  return fs.existsSync(subtitlePath(videoPath));
}

export function isFetching(videoPath: string): boolean {
  return inFlight.has(videoPath);
}

// ── OS hash (first + last 64 KB, little-endian sum) ──────────────────────────

async function computeOsHash(filePath: string, fileSize: number): Promise<string> {
  if (fileSize < 131072) return '';
  const CHUNK = 65536;
  const buf = Buffer.alloc(CHUNK);
  const fd = await fs.promises.open(filePath, 'r');
  try {
    let hash = BigInt(fileSize);
    await fd.read(buf, 0, CHUNK, 0);
    for (let i = 0; i < CHUNK; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn;
    await fd.read(buf, 0, CHUNK, fileSize - CHUNK);
    for (let i = 0; i < CHUNK; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn;
    return hash.toString(16).padStart(16, '0');
  } finally {
    await fd.close();
  }
}

// ── Title extraction from filename ───────────────────────────────────────────

export function extractTitle(filename: string): string {
  let t = filename.replace(/\.mp4$/i, '').replace(/[._]/g, ' ');
  // Cut at year
  t = t.replace(/\b(19|20)\d{2}\b.*/i, '');
  // Cut at quality/codec tags
  t = t.replace(/\b(480p|576p|720p|1080p|2160p|4k|uhd|hdr|bluray|blu-ray|brrip|webrip|web[-.]dl|dvdrip|hdtv|hdcam|x264|x265|hevc|avc|xvid|divx|remux|repack|proper|extended|theatrical|uncut)\b.*/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

// ── OpenSubtitles API ─────────────────────────────────────────────────────────

interface OsFile { file_id: number; }
interface OsAttrs { files: OsFile[]; ai_translated: boolean; machine_translated: boolean; }
interface OsEntry { attributes: OsAttrs; }
interface OsSearchResp { data?: OsEntry[]; }
interface OsDownloadResp { link?: string; }

async function searchOs(params: Record<string, string>): Promise<number | null> {
  const qs = new URLSearchParams({ ...params, languages: config.subtitleLang }).toString();
  try {
    const res = await fetch(`${OS_API}/subtitles?${qs}`, {
      headers: { 'Api-Key': config.openSubtitlesApiKey, 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json() as OsSearchResp;
    // Prefer non-AI/machine results, but accept any
    const entries = json.data ?? [];
    const best = entries.find(e => !e.attributes.ai_translated && !e.attributes.machine_translated)
      ?? entries[0];
    return best?.attributes.files[0]?.file_id ?? null;
  } catch {
    return null;
  }
}

async function downloadOs(fileId: number): Promise<string | null> {
  try {
    const res = await fetch(`${OS_API}/download`, {
      method: 'POST',
      headers: { 'Api-Key': config.openSubtitlesApiKey, 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json() as OsDownloadResp;
    if (!json.link) return null;
    const dl = await fetch(json.link, { signal: AbortSignal.timeout(15000) });
    if (!dl.ok) return null;
    return dl.text();
  } catch {
    return null;
  }
}

function srtToVtt(content: string): string {
  if (content.trimStart().startsWith('WEBVTT')) return content;
  return 'WEBVTT\n\n' + content.trim().replace(/\r\n/g, '\n').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function fetchSubtitles(videoPath: string, filename: string): Promise<boolean> {
  if (!config.openSubtitlesApiKey) return false;
  if (inFlight.has(videoPath)) return false;
  if (hasSubtitles(videoPath)) return true;

  inFlight.add(videoPath);
  try {
    const stat = await fs.promises.stat(videoPath);
    let fileId: number | null = null;

    // 1. Hash search (most accurate)
    const hash = await computeOsHash(videoPath, stat.size);
    if (hash) fileId = await searchOs({ moviehash: hash });

    // 2. Title fallback
    if (!fileId) {
      const title = extractTitle(filename);
      if (title) fileId = await searchOs({ query: title });
    }

    if (!fileId) return false;

    const content = await downloadOs(fileId);
    if (!content) return false;

    await fs.promises.writeFile(subtitlePath(videoPath), srtToVtt(content), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    inFlight.delete(videoPath);
  }
}
