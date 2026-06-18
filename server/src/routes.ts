import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { FastifyInstance } from 'fastify';
import { config } from './config';
import {
  createRoom, getRoomByToken, listLibraryFiles,
  purgeExpiredRooms, upsertLibraryMeta, deleteLibraryMeta, getLibraryMeta, renameLibraryFile,
} from './db';
import { generateThumbnailAsync, thumbPath, extractMetadata } from './ffmpeg';
import { getRuntimeByToken } from './roomManager';
import { subtitlePath } from './subtitles';

// ── Remote log buffer ─────────────────────────────────────────────────────────
interface LogEntry { ts: number; device: string; level: string; msg: string; }
const logBuffer: LogEntry[] = [];
const logSubs = new Set<(e: LogEntry | 'clear') => void>();
function pushLog(e: LogEntry) {
  logBuffer.push(e);
  if (logBuffer.length > 1000) logBuffer.shift();
  logSubs.forEach(fn => fn(e));
}
function clearLogs() {
  logBuffer.length = 0;
  logSubs.forEach(fn => fn('clear'));
}

const LOG_VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WatchTogether Logs</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e2e8f0;font-family:monospace;font-size:13px;display:flex;flex-direction:column;height:100vh}
#hdr{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #2d3148;flex-shrink:0;background:#1a1d27}
#hdr h2{font-size:14px;font-weight:700;color:#94a3b8;letter-spacing:.05em}
#status{font-size:11px;padding:2px 8px;border-radius:4px;background:#2d3148}
#status.ok{color:#4ade80}#status.err{color:#f87171}
#filters{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.fbtn{padding:3px 10px;border:1px solid #2d3148;border-radius:4px;background:transparent;color:#94a3b8;cursor:pointer;font-size:11px}
.fbtn.active{border-color:currentColor}
#clr{padding:4px 12px;background:#2d3148;border:none;border-radius:4px;color:#94a3b8;cursor:pointer;font-size:12px}
#clr:hover{color:#e2e8f0}
#log{flex:1;overflow-y:auto;padding:4px 0}
.row{display:flex;gap:8px;padding:2px 12px;border-bottom:1px solid rgba(255,255,255,0.03)}
.row:hover{background:rgba(255,255,255,0.03)}
.ts{color:#475569;flex-shrink:0;width:100px}
.dev{flex-shrink:0;width:90px;font-weight:700}
.msg{color:#e2e8f0;word-break:break-all}
.msg.warn{color:#facc15}.msg.error{color:#f87171}
#jump{position:fixed;bottom:16px;right:16px;background:#6366f1;color:#fff;border:none;border-radius:20px;padding:6px 14px;cursor:pointer;font-size:12px;display:none}
</style>
</head>
<body>
<div id="hdr">
  <h2>LIVE LOGS</h2>
  <span id="status">connecting…</span>
  <div id="filters"></div>
  <button id="clr" onclick="doClear()">Clear</button>
</div>
<div id="log"></div>
<button id="jump" onclick="jumpToBottom()">↓ Jump to bottom</button>
<script>
const logEl=document.getElementById('log');
const statusEl=document.getElementById('status');
const filtersEl=document.getElementById('filters');
const jumpEl=document.getElementById('jump');
const devColors={};const devFilters={};let colorIdx=0;
const PALETTE=['#60a5fa','#34d399','#f97316','#a78bfa','#fb7185','#facc15','#2dd4bf'];
let autoScroll=true;
logEl.addEventListener('scroll',()=>{
  const atBottom=logEl.scrollTop+logEl.clientHeight>=logEl.scrollHeight-30;
  autoScroll=atBottom;
  jumpEl.style.display=atBottom?'none':'block';
});
function jumpToBottom(){logEl.scrollTop=logEl.scrollHeight;autoScroll=true;jumpEl.style.display='none';}
function devColor(dev){if(!devColors[dev]){devColors[dev]=PALETTE[colorIdx++%PALETTE.length];}return devColors[dev];}
function ensureFilter(dev){
  if(devFilters[dev]!==undefined)return;
  devFilters[dev]=true;
  const btn=document.createElement('button');
  btn.className='fbtn active';btn.style.color=devColor(dev);btn.textContent=dev;
  btn.onclick=()=>{devFilters[dev]=!devFilters[dev];btn.classList.toggle('active',devFilters[dev]);applyFilters();};
  filtersEl.appendChild(btn);
}
function applyFilters(){
  document.querySelectorAll('.row[data-dev]').forEach(r=>{
    r.style.display=devFilters[r.dataset.dev]?'':'none';
  });
}
function addEntry(e){
  ensureFilter(e.device);
  const d=new Date(e.ts);
  const t=d.toLocaleTimeString('en-US',{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0');
  const row=document.createElement('div');
  row.className='row';row.dataset.dev=e.device;
  row.style.display=devFilters[e.device]?'':'none';
  row.innerHTML='<span class="ts">'+t+'</span><span class="dev" style="color:'+devColor(e.device)+'">'+e.device+'</span><span class="msg '+e.level+'">'+e.msg.replace(/</g,'&lt;')+'</span>';
  logEl.appendChild(row);
  if(autoScroll)logEl.scrollTop=logEl.scrollHeight;
}
const es=new EventSource('/api/debug/logs/stream');
es.onopen=()=>{statusEl.textContent='connected';statusEl.className='ok';};
es.onmessage=(ev)=>{if(ev.data==='clear'){logEl.innerHTML='';return;}try{addEntry(JSON.parse(ev.data));}catch{}};
es.onerror=()=>{statusEl.textContent='reconnecting…';statusEl.className='err';};
function doClear(){fetch('/api/debug/logs',{method:'DELETE'});}
<\/script>
</body>
</html>`;

const SAFE_TOKEN_RE    = /^[0-9a-f]{64}$/;
const SAFE_FILENAME_RE = /^[\w\-. ]+\.mp4$/i;

function generateToken(): string { return crypto.randomBytes(32).toString('hex'); }
function generateId(): string    { return crypto.randomBytes(16).toString('hex'); }

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').substring(0, 200);
}

function libraryFilePath(filename: string): string {
  return path.join(config.mediaDir, 'library', filename);
}

function assertLibraryPath(filename: string): string {
  const base = path.resolve(config.mediaDir, 'library');
  const full = path.resolve(base, filename);
  if (!full.startsWith(base + path.sep)) throw new Error('Invalid path');
  return full;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {

  // ── Debug: log viewer (HTML) ───────────────────────────────────────────────
  app.get('/api/debug/logs', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(LOG_VIEWER_HTML);
  });

  // ── Debug: log ingestion ───────────────────────────────────────────────────
  app.post('/api/debug/logs', async (req, reply) => {
    const body = req.body as { device?: string; entries?: Array<{ ts: number; level: string; msg: string }> };
    const device = String(body?.device ?? 'unknown').slice(0, 30);
    for (const e of (body?.entries ?? [])) {
      pushLog({ ts: Number(e.ts), device, level: String(e.level), msg: String(e.msg).slice(0, 500) });
    }
    return reply.send({ ok: true });
  });

  // ── Debug: delete logs ────────────────────────────────────────────────────
  app.delete('/api/debug/logs', async (_req, reply) => {
    clearLogs();
    return reply.send({ ok: true });
  });

  // ── Debug: SSE log stream ─────────────────────────────────────────────────
  app.get('/api/debug/logs/stream', async (req, reply) => {
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    for (const e of logBuffer) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    const send = (e: LogEntry | 'clear') => {
      try { res.write(e === 'clear' ? 'data: clear\n\n' : `data: ${JSON.stringify(e)}\n\n`); } catch {}
    };
    logSubs.add(send);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
    req.raw.on('close', () => { clearInterval(ka); logSubs.delete(send); });
    return new Promise<void>(() => {});
  });

  // ── Client config (upload URL override for bypassing Cloudflare) ──────────
  app.get('/api/config', async (_req, reply) => {
    return reply.send({ uploadUrl: config.uploadUrl || null });
  });

  // ── Library: list files with metadata ─────────────────────────────────────
  app.get('/api/library', async (_req, reply) => {
    return reply.send({ files: listLibraryFiles() });
  });

  // ── Library: serve thumbnail ───────────────────────────────────────────────
  app.get('/api/library/:filename/thumb', async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!SAFE_FILENAME_RE.test(filename)) return reply.status(400).send();

    const tp = thumbPath(filename);
    if (!fs.existsSync(tp)) {
      // Return a 1x1 transparent placeholder so the client can show something
      return reply.status(404).send();
    }
    reply.header('Content-Type', 'image/jpeg');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(tp));
  });

  // ── Library: delete a file ─────────────────────────────────────────────────
  app.delete('/api/library/:filename', {
    config: { rateLimit: { max: 20, timeWindow: '1m' } },
  }, async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (!SAFE_FILENAME_RE.test(filename)) return reply.status(400).send({ error: 'Invalid filename' });

    let filePath: string;
    try { filePath = assertLibraryPath(filename); } catch { return reply.status(400).send({ error: 'Invalid path' }); }

    if (!fs.existsSync(filePath)) return reply.status(404).send({ error: 'Not found' });

    fs.rmSync(filePath, { force: true });

    const tp = thumbPath(filename);
    if (fs.existsSync(tp)) fs.rmSync(tp, { force: true });

    const sp = subtitlePath(filePath);
    if (fs.existsSync(sp)) fs.rmSync(sp, { force: true });

    deleteLibraryMeta(filename);

    return reply.send({ ok: true });
  });

  // ── Library: rename a file ────────────────────────────────────────────────
  app.patch('/api/library/:filename', {
    config: { rateLimit: { max: 20, timeWindow: '1m' } },
  }, async (req, reply) => {
    const { filename } = req.params as { filename: string };
    const body = req.body as { newFilename?: string };
    const newFilename = body?.newFilename?.trim();

    if (!SAFE_FILENAME_RE.test(filename)) return reply.status(400).send({ error: 'Invalid filename' });
    if (!newFilename || !SAFE_FILENAME_RE.test(newFilename)) {
      return reply.status(400).send({ error: 'Invalid new filename' });
    }
    if (filename === newFilename) return reply.send({ ok: true });

    let oldPath: string;
    let newPath: string;
    try {
      oldPath = assertLibraryPath(filename);
      newPath = assertLibraryPath(newFilename);
    } catch { return reply.status(400).send({ error: 'Invalid path' }); }

    if (!fs.existsSync(oldPath)) return reply.status(404).send({ error: 'Not found' });
    if (fs.existsSync(newPath)) return reply.status(409).send({ error: 'A file with that name already exists' });

    fs.renameSync(oldPath, newPath);

    // Rename thumbnail
    const oldThumb = thumbPath(filename);
    const newThumb = thumbPath(newFilename);
    if (fs.existsSync(oldThumb)) {
      try { fs.renameSync(oldThumb, newThumb); } catch { /* ignore */ }
    }

    // Rename subtitle
    const oldSub = subtitlePath(oldPath);
    const newSub = subtitlePath(newPath);
    if (fs.existsSync(oldSub)) {
      try { fs.renameSync(oldSub, newSub); } catch { /* ignore */ }
    }

    renameLibraryFile(filename, newFilename, oldPath, newPath);
    return reply.send({ ok: true });
  });

  // ── Upload: save to library, generate thumb, create room ──────────────────
  app.post('/api/upload', {
    config: { rateLimit: { max: 5, timeWindow: '1m' } },
  }, async (req, reply) => {
    const parts = req.parts();
    let savedFilename = '';
    let savedPath = '';
    let savedSize  = 0;

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (part.fieldname !== 'video') { await part.toBuffer(); continue; }

      if (part.mimetype !== 'video/mp4' && !part.filename?.toLowerCase().endsWith('.mp4')) {
        await part.toBuffer();
        return reply.status(400).send({ error: 'Only MP4 files are allowed' });
      }

      savedFilename = sanitizeFilename(part.filename ?? 'video.mp4');
      if (!savedFilename.toLowerCase().endsWith('.mp4')) savedFilename += '.mp4';

      const libraryDir = path.join(config.mediaDir, 'library');
      fs.mkdirSync(libraryDir, { recursive: true });

      savedPath = libraryFilePath(savedFilename);
      const writeStream = fs.createWriteStream(savedPath);
      let bytesWritten = 0;

      try {
        await pipeline(
          part.file,
          async function* (source) {
            for await (const chunk of source) {
              bytesWritten += (chunk as Buffer).length;
              if (bytesWritten > config.maxUploadBytes) throw new Error('File too large');
              yield chunk;
            }
          },
          writeStream,
        );
        savedSize = bytesWritten;
      } catch (err: unknown) {
        writeStream.destroy();
        fs.rmSync(savedPath, { force: true });
        const msg = err instanceof Error ? err.message : 'Upload failed';
        return reply.status(413).send({ error: msg });
      }
    }

    if (!savedFilename || !savedPath || savedSize === 0) {
      return reply.status(400).send({ error: 'No video file provided' });
    }

    // Extract duration + generate thumbnail (non-blocking)
    const { duration } = await extractMetadata(savedPath);
    upsertLibraryMeta(savedFilename, duration, false);

    generateThumbnailAsync(savedPath, savedFilename, (ok) => {
      if (ok) upsertLibraryMeta(savedFilename, duration, true);
    });

    // Create room
    const roomToken = generateToken();
    const now = Date.now();
    createRoom({
      id: generateId(),
      token: roomToken,
      media_path: savedPath,
      media_filename: savedFilename,
      media_size: savedSize,
      created_at: now,
      expires_at: now + config.roomTtlHours * 3600 * 1000,
    });

    purgeExpiredRooms();

    return reply.status(201).send({
      roomToken,
      roomUrl: `${config.baseUrl}/room/${roomToken}`,
      filename: savedFilename,
    });
  });

  // ── Room from library ──────────────────────────────────────────────────────
  app.post('/api/rooms', {
    config: { rateLimit: { max: 10, timeWindow: '1m' } },
  }, async (req, reply) => {
    const body = req.body as { filename?: string };
    const filename = body?.filename;
    if (!filename || !SAFE_FILENAME_RE.test(filename)) {
      return reply.status(400).send({ error: 'Invalid filename' });
    }

    let filePath: string;
    try { filePath = assertLibraryPath(filename); } catch { return reply.status(400).send({ error: 'Invalid path' }); }

    if (!fs.existsSync(filePath)) return reply.status(404).send({ error: 'File not found' });

    const stat   = fs.statSync(filePath);
    const meta   = getLibraryMeta(filename);
    const roomToken = generateToken();
    const now    = Date.now();

    createRoom({
      id: generateId(),
      token: roomToken,
      media_path: filePath,
      media_filename: filename,
      media_size: stat.size,
      created_at: now,
      expires_at: now + config.roomTtlHours * 3600 * 1000,
    });

    purgeExpiredRooms();

    return reply.status(201).send({
      roomToken,
      roomUrl: `${config.baseUrl}/room/${roomToken}`,
      resumeTime: meta?.last_time ?? 0,
    });
  });

  // ── Media: serve video with byte-range support ─────────────────────────────
  app.get('/api/media/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!SAFE_TOKEN_RE.test(token)) return reply.status(400).send({ error: 'Invalid token' });

    const row = getRoomByToken(token);
    if (!row) return reply.status(404).send({ error: 'Room not found' });
    if (Date.now() > row.expires_at) return reply.status(410).send({ error: 'Room expired' });

    const resolvedMediaDir = path.resolve(config.mediaDir);
    const resolvedPath     = path.resolve(row.media_path);
    if (!resolvedPath.startsWith(resolvedMediaDir + path.sep)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    if (!fs.existsSync(resolvedPath)) return reply.status(404).send({ error: 'Media file not found' });

    const stat     = fs.statSync(resolvedPath);
    const fileSize = stat.size;
    const rangeHeader = (req.headers as Record<string, string>).range;

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', 'video/mp4');

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) return reply.status(416).send();

      const start = parseInt(match[1], 10);
      const end   = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        reply.header('Content-Range', `bytes */${fileSize}`);
        return reply.status(416).send();
      }

      reply.header('Content-Range',  `bytes ${start}-${end}/${fileSize}`);
      reply.header('Content-Length', String(end - start + 1));
      reply.status(206);
      return reply.send(fs.createReadStream(resolvedPath, { start, end }));
    }

    reply.header('Content-Length', String(fileSize));
    return reply.send(fs.createReadStream(resolvedPath));
  });

  // ── Room info ──────────────────────────────────────────────────────────────
  app.get('/api/rooms/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!SAFE_TOKEN_RE.test(token)) return reply.status(400).send({ error: 'Invalid token' });

    const row = getRoomByToken(token);
    if (!row) return reply.status(404).send({ error: 'Room not found' });
    if (Date.now() > row.expires_at) return reply.status(410).send({ error: 'Room expired' });

    const runtime = getRuntimeByToken(token);
    return reply.send({
      token:         row.token,
      mediaFilename: row.media_filename,
      mediaSize:     row.media_size,
      createdAt:     row.created_at,
      expiresAt:     row.expires_at,
      viewerCount:   runtime?.viewers.size ?? 0,
      state:         runtime?.state ?? 'WAITING_FOR_VIEWERS',
    });
  });
}
