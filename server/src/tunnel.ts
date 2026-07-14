import { spawn, ChildProcess } from 'child_process';

// Spawns and supervises `cloudflared` directly from the server process, so
// exposing PookieFlix publicly is just "paste a token" - no separate
// container, no terminal command, no manual OS-native install.

// Real Cloudflare tunnel tokens are 150+ characters of unbroken base64url
// text. Cloudflare's dashboard shows a different install/run command per
// OS/Docker/architecture, and users paste the whole thing rather than just
// the token - extracting the longest token-shaped substring handles any of
// those formats without needing to match each one specifically.
const TOKEN_LIKE = /[A-Za-z0-9_-]{40,}/g;

export function extractTunnelToken(input: string): string {
  const trimmed = input.trim();
  const matches = trimmed.match(TOKEN_LIKE);
  if (!matches) return trimmed;
  return matches.reduce((longest, m) => (m.length > longest.length ? m : longest), '');
}

export type TunnelState = 'stopped' | 'starting' | 'connected' | 'error';
export interface TunnelStatus {
  state: TunnelState;
  message?: string;
  connectedAt?: number;
}

let proc: ChildProcess | null = null;
let currentToken: string | null = null;
let stopped = true;
let status: TunnelStatus = { state: 'stopped' };
const recentOutput: string[] = [];
const MAX_RECENT_LINES = 5;

export function getTunnelStatus(): TunnelStatus {
  return status;
}

function killCurrent(): void {
  if (proc) {
    proc.removeAllListeners('exit');
    proc.kill('SIGTERM');
    proc = null;
  }
}

function trackOutput(chunk: Buffer): void {
  const text = chunk.toString().trim();
  if (!text) return;
  console.log(`[cloudflared] ${text}`);
  for (const line of text.split('\n')) {
    recentOutput.push(line);
    if (recentOutput.length > MAX_RECENT_LINES) recentOutput.shift();
  }
  if (text.includes('Registered tunnel connection')) {
    status = { state: 'connected', connectedAt: Date.now() };
  }
}

function spawnTunnel(token: string): void {
  status = { state: 'starting' };
  recentOutput.length = 0;
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', token], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc = child;

  child.stdout?.on('data', trackOutput);
  child.stderr?.on('data', trackOutput);

  child.on('exit', (code, signal) => {
    if (proc !== child) return; // already superseded by a newer spawn
    proc = null;
    if (stopped) { status = { state: 'stopped' }; return; }
    const lastLine = recentOutput.filter(Boolean).at(-1);
    status = { state: 'error', message: lastLine || `cloudflared exited unexpectedly (code=${code} signal=${signal})` };
    console.log(`[cloudflared] exited unexpectedly (code=${code} signal=${signal}) - restarting in 5s`);
    setTimeout(() => {
      if (!stopped && currentToken) spawnTunnel(currentToken);
    }, 5000);
  });
}

export function startTunnel(rawToken: string): void {
  const token = extractTunnelToken(rawToken);
  if (!stopped && currentToken === token && proc) return; // already running with this token
  killCurrent();
  currentToken = token;
  stopped = false;
  spawnTunnel(token);
}

export function stopTunnel(): void {
  stopped = true;
  currentToken = null;
  status = { state: 'stopped' };
  killCurrent();
}

// Drops and re-establishes the tunnel with the same token — useful when one
// of cloudflared's edge connections gets stuck in a failure loop (seen live:
// a specific connIndex repeatedly hitting "control stream encountered a
// failure" while the other connections and the server itself were fine).
// A fresh process negotiates a brand new set of edge connections rather than
// waiting on cloudflared's own internal retry/backoff for the stuck one.
export function reconnectTunnel(): boolean {
  if (!currentToken) return false;
  const token = currentToken;
  killCurrent();
  stopped = false;
  spawnTunnel(token);
  return true;
}

export function isTunnelRunning(): boolean {
  return !stopped && proc !== null;
}
