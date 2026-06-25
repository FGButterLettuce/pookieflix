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
interface OsAttrs { files: OsFile[]; ai_translated: boolean; machine_translated: boolean; movie_name?: string; release?: string; }
interface OsEntry { attributes: OsAttrs; }
interface OsSearchResp { data?: OsEntry[]; }
interface OsDownloadResp { link?: string; }

async function searchOsWithLabel(params: Record<string, string>): Promise<{ id: number; label: string } | null> {
  const qs = new URLSearchParams({ ...params, languages: config.subtitleLang }).toString();
  try {
    const res = await fetch(`${OS_API}/subtitles?${qs}`, {
      headers: { 'Api-Key': config.openSubtitlesApiKey, 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json() as OsSearchResp;
    const entries = json.data ?? [];
    const best = entries.find(e => !e.attributes.ai_translated && !e.attributes.machine_translated) ?? entries[0];
    if (!best) return null;
    const id = best.attributes.files[0]?.file_id;
    if (!id) return null;
    const parts = [best.attributes.movie_name, best.attributes.release].filter(Boolean);
    return { id, label: parts.join(' · ') || 'Unknown' };
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

export function srtToVtt(content: string): string {
  if (content.trimStart().startsWith('WEBVTT')) return content;
  return 'WEBVTT\n\n' + content.trim().replace(/\r\n/g, '\n').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');
}

// ── Public entry points ───────────────────────────────────────────────────────

export async function searchSubtitles(query: string): Promise<{ fileId: number; label: string }[]> {
  if (!config.openSubtitlesApiKey) return [];
  const qs = new URLSearchParams({ query, languages: config.subtitleLang }).toString();
  try {
    const res = await fetch(`${OS_API}/subtitles?${qs}`, {
      headers: { 'Api-Key': config.openSubtitlesApiKey, 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json() as OsSearchResp;
    return (json.data ?? []).slice(0, 10).flatMap(e => {
      const a = e.attributes;
      const fid = a.files[0]?.file_id;
      if (!fid) return [];
      const parts = [a.movie_name, a.release].filter(Boolean);
      const label = parts.join(' · ') || 'Unknown';
      return [{ fileId: fid, label }];
    });
  } catch {
    return [];
  }
}

export async function fetchSubtitles(videoPath: string, filename: string, fileId?: number, label?: string): Promise<string | null> {
  if (!config.openSubtitlesApiKey) return null;
  if (inFlight.has(videoPath)) return null;
  if (!fileId && hasSubtitles(videoPath)) return null;

  inFlight.add(videoPath);
  try {
    let targetId: number | null = fileId ?? null;
    let chosenLabel = label ?? null;

    if (!targetId) {
      const stat = await fs.promises.stat(videoPath);
      const hash = await computeOsHash(videoPath, stat.size);
      if (hash) {
        const res = await searchOsWithLabel({ moviehash: hash });
        targetId = res?.id ?? null;
        chosenLabel = res?.label ?? null;
      }
      if (!targetId) {
        const title = extractTitle(filename);
        if (title) {
          const res = await searchOsWithLabel({ query: title });
          targetId = res?.id ?? null;
          chosenLabel = res?.label ?? null;
        }
      }
    }

    if (!targetId) return null;
    const content = await downloadOs(targetId);
    if (!content) return null;
    await fs.promises.writeFile(subtitlePath(videoPath), srtToVtt(content), 'utf8');
    return chosenLabel;
  } catch {
    return null;
  } finally {
    inFlight.delete(videoPath);
  }
}
