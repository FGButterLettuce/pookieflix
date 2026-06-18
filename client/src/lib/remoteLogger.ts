const SESSION_ID = Math.random().toString(36).slice(2, 8).toUpperCase();
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
export const DEVICE_ID = `${IS_MOBILE ? 'MOB' : 'DSK'}-${SESSION_ID}`;

type Level = 'log' | 'warn' | 'error';
interface Entry { ts: number; level: Level; msg: string; }

const queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  if (!queue.length) return;
  const batch = queue.splice(0);
  fetch('/api/debug/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: DEVICE_ID, entries: batch }),
  }).catch(() => {});
}

function add(level: Level, ...args: unknown[]) {
  const msg = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 500);
  queue.push({ ts: Date.now(), level, msg });
  if (queue.length >= 20) flush();
  else if (!timer) timer = setTimeout(flush, 800);
}

export const rlog = {
  log:   (...a: unknown[]) => add('log',   ...a),
  warn:  (...a: unknown[]) => add('warn',  ...a),
  error: (...a: unknown[]) => add('error', ...a),
};
