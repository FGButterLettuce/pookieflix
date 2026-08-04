import fs from 'fs';
import { spawn } from 'child_process';
import { config } from './config';

const OS_API = 'https://api.opensubtitles.com/api/v1';
const UA = 'PookieFlix v1.0';

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

// Every OpenSubtitles call below degrades gracefully on failure (subtitles
// are a nicety, never worth blocking or erroring the rest of the app over),
// but that previously meant a 403/429/network failure looked *identical* to
// "no subtitles found" — impossible to diagnose. Log the real reason instead
// of silently discarding it; the caller's behavior (return null/[]) is
// unchanged.
async function logOsFailure(context: string, res: Response): Promise<void> {
  const body = await res.text().catch(() => '');
  console.error(`[subtitles] ${context} failed: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
}

async function searchOsWithLabel(params: Record<string, string>): Promise<{ id: number; label: string } | null> {
  const qs = new URLSearchParams({ ...params, languages: config.subtitleLang }).toString();
  try {
    const res = await fetch(`${OS_API}/subtitles?${qs}`, {
      headers: { 'Api-Key': config.openSubtitlesApiKey, 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { await logOsFailure('search', res); return null; }
    const json = await res.json() as OsSearchResp;
    const entries = json.data ?? [];
    const best = entries.find(e => !e.attributes.ai_translated && !e.attributes.machine_translated) ?? entries[0];
    if (!best) return null;
    const id = best.attributes.files[0]?.file_id;
    if (!id) return null;
    const parts = [best.attributes.movie_name, best.attributes.release].filter(Boolean);
    return { id, label: parts.join(' · ') || 'Unknown' };
  } catch (err) {
    console.error('[subtitles] search threw:', err);
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
    if (!res.ok) { await logOsFailure('download request', res); return null; }
    const json = await res.json() as OsDownloadResp;
    if (!json.link) { console.error('[subtitles] download request succeeded but returned no link'); return null; }
    const dl = await fetch(json.link, { signal: AbortSignal.timeout(15000) });
    if (!dl.ok) { await logOsFailure('download file', dl); return null; }
    return dl.text();
  } catch (err) {
    console.error('[subtitles] download threw:', err);
    return null;
  }
}

export function srtToVtt(content: string): string {
  if (content.trimStart().startsWith('WEBVTT')) return content;
  return 'WEBVTT\n\n' + content.trim().replace(/\r\n/g, '\n').replace(/(\d+:\d+(?::\d+)?),(\d+)/g, '$1.$2');
}

export function vttToSrt(content: string): string {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n+/, '');
  const blocks = withoutHeader.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
  let index = 0;

  const toSrtTimestamp = (ts: string): string => {
    const [time, ms] = ts.split('.');
    const parts = time.split(':');
    const [h, m, s] = parts.length === 3 ? parts : ['00', ...parts];
    return `${h.padStart(2, '0')}:${m}:${s},${ms}`;
  };

  const srtBlocks = blocks.flatMap(block => {
    const lines = block.split('\n');
    const cueLineIdx = lines.findIndex(l => l.includes('-->'));
    if (cueLineIdx === -1) return [];
    index += 1;
    const [startTs, , endTs] = lines[cueLineIdx].split(' ');
    const timeLine = `${toSrtTimestamp(startTs)} --> ${toSrtTimestamp(endTs)}`;
    const textLines = lines.slice(cueLineIdx + 1);
    return [`${index}\n${timeLine}\n${textLines.join('\n')}`];
  });
  return srtBlocks.join('\n\n') + '\n';
}

// ── Subtitle sync (alass) ─────────────────────────────────────────────────────

const syncInFlight = new Set<string>();
const SYNC_TIMEOUT_MS = 2 * 60 * 1000; // 2 min — alass is normally ~30s for a full movie

function backupPath(videoPath: string): string {
  return subtitlePath(videoPath) + '.presync.bak';
}

interface AlassResult { ok: boolean; stderr: string; timedOut: boolean; }

function runAlass(referencePath: string, inputSrt: string, outputSrt: string): Promise<AlassResult> {
  return new Promise(resolve => {
    const proc = spawn('alass', [referencePath, inputSrt, outputSrt]);
    let stderr = '';
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* ignore */ }
    }, SYNC_TIMEOUT_MS);
    // alass's own progress bar overwrites itself with \r — only the tail after
    // the last one is meaningful, the rest is just terminal-width noise.
    const lastLine = () => stderr.split('\r').pop()?.trim().slice(-300) ?? '';
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr: lastLine(), timedOut });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: err.message, timedOut: false });
    });
  });
}

export async function syncSubtitles(videoPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const vttPath = subtitlePath(videoPath);
  if (!fs.existsSync(vttPath)) return { ok: false, error: 'No subtitles to sync' };
  if (syncInFlight.has(videoPath)) return { ok: false, error: 'Sync already in progress' };

  syncInFlight.add(videoPath);
  const tmpSrtIn = vttPath + '.sync-in.srt';
  const tmpSrtOut = vttPath + '.sync-out.srt';
  const tmpVtt = vttPath + '.new.vtt';
  try {
    const vttContent = fs.readFileSync(vttPath, 'utf8');
    fs.writeFileSync(tmpSrtIn, vttToSrt(vttContent), 'utf8');

    const result = await runAlass(videoPath, tmpSrtIn, tmpSrtOut);
    if (!result.ok) {
      const reason = result.timedOut
        ? `timed out after ${SYNC_TIMEOUT_MS / 1000}s`
        : result.stderr || 'no error output';
      return { ok: false, error: `alass failed to align subtitles: ${reason}` };
    }

    // Back up the pre-sync content only now that we know the sync succeeded —
    // backing this up unconditionally at the top would let a *failed* re-sync
    // overwrite a still-valid backup from an earlier successful sync.
    const srtContent = fs.readFileSync(tmpSrtOut, 'utf8');
    fs.writeFileSync(tmpVtt, srtToVtt(srtContent), 'utf8');
    fs.copyFileSync(vttPath, backupPath(videoPath));
    fs.renameSync(tmpVtt, vttPath);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Unexpected error during sync' };
  } finally {
    syncInFlight.delete(videoPath);
    try { fs.rmSync(tmpSrtIn); } catch { /* ignore */ }
    try { fs.rmSync(tmpSrtOut); } catch { /* ignore */ }
    try { fs.rmSync(tmpVtt); } catch { /* ignore */ }
  }
}

export function undoSync(videoPath: string): boolean {
  const backup = backupPath(videoPath);
  if (!fs.existsSync(backup)) return false;
  fs.copyFileSync(backup, subtitlePath(videoPath));
  fs.rmSync(backup);
  return true;
}

// ── Manual subtitle shift ─────────────────────────────────────────────────────
// Fallback for when alass can't find an audio-alignment match (or gets it wrong)
// — a plain uniform offset applied to every cue, nudged interactively.

function parseVttTimestamp(ts: string): number {
  const parts = ts.split(':');
  const [h, m, s] = parts.length === 3 ? parts : ['0', ...parts];
  return parseInt(h, 10) * 3600000 + parseInt(m, 10) * 60000 + Math.round(parseFloat(s) * 1000);
}

function formatVttTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const msRem = clamped % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msRem).padStart(3, '0')}`;
}

const VTT_CUE_TIME_RE = /(\d{1,2}:)?\d{2}:\d{2}\.\d{3} --> (\d{1,2}:)?\d{2}:\d{2}\.\d{3}/g;

export function shiftVtt(content: string, deltaMs: number): string {
  return content.replace(VTT_CUE_TIME_RE, (line) => {
    const [start, end] = line.split(' --> ');
    return `${formatVttTimestamp(parseVttTimestamp(start) + deltaMs)} --> ${formatVttTimestamp(parseVttTimestamp(end) + deltaMs)}`;
  });
}

export function shiftSubtitles(videoPath: string, deltaMs: number): { ok: true } | { ok: false; error: string } {
  const vttPath = subtitlePath(videoPath);
  if (!fs.existsSync(vttPath)) return { ok: false, error: 'No subtitles to shift' };
  try {
    // Only back up once per editing session — same rule as syncSubtitles — so
    // "Undo" always returns to the state before any manual adjustment, not just
    // the last single nudge.
    if (!fs.existsSync(backupPath(videoPath))) {
      fs.copyFileSync(vttPath, backupPath(videoPath));
    }
    const content = fs.readFileSync(vttPath, 'utf8');
    fs.writeFileSync(vttPath, shiftVtt(content, deltaMs), 'utf8');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Unexpected error shifting subtitles' };
  }
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
    if (!res.ok) { await logOsFailure('manual search', res); return []; }
    const json = await res.json() as OsSearchResp;
    return (json.data ?? []).slice(0, 10).flatMap(e => {
      const a = e.attributes;
      const fid = a.files[0]?.file_id;
      if (!fid) return [];
      const parts = [a.movie_name, a.release].filter(Boolean);
      const label = parts.join(' · ') || 'Unknown';
      return [{ fileId: fid, label }];
    });
  } catch (err) {
    console.error('[subtitles] manual search threw:', err);
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
  } catch (err) {
    console.error(`[subtitles] fetchSubtitles(${filename}) threw:`, err);
    return null;
  } finally {
    inFlight.delete(videoPath);
  }
}
