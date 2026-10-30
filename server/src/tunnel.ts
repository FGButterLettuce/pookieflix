import { spawn, ChildProcess } from 'child_process';
import { TunnelFailureMonitor } from './tunnelFailureMonitor';

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
const failureMonitor = new TunnelFailureMonitor({
  threshold: 6,
  windowMs: 30_000,
  cooldownMs: 5 * 60_000,
});
let autoReconnectScheduled = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

export function getTunnelStatus(): TunnelStatus {
  return status;
}

function killCurrent(): void {
  // A crash restart still pending would otherwise start a second connector
  // and orphan whichever process loses the race for `proc`.
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
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
    if (failureMonitor.record(line) && !autoReconnectScheduled) {
      autoReconnectScheduled = true;
      console.warn('[cloudflared] repeated HLS stream failures detected; negotiating fresh edge connections');
      setTimeout(() => {
        autoReconnectScheduled = false;
        if (!stopped && currentToken) reconnectTunnel();
      }, 250);
    }
  }
  if (text.includes('Registered tunnel connection')) {
    status = { state: 'connected', connectedAt: Date.now() };
  }
}

function spawnTunnel(token: string): void {
  status = { state: 'starting' };
  recentOutput.length = 0;
  // Tried forcing --protocol http2 here on the theory that cloudflared's default QUIC
  // transport was the throughput bottleneck (cloudflared's own maintainers note QUIC is
  // more overhead-heavy in this tool, github.com/cloudflare/cloudflared#895, and it's a
  // commonly-reported cause of exactly this symptom). Measured live and it was WORSE on
  // this box's actual network path - QUIC (default) got ~17Mbps, HTTP/2 got 5.6-10.8Mbps
  // across repeated tests. Reverted. Don't re-attempt without re-measuring first; the
  // general guidance didn't hold for this specific network/PoP routing.
  // The token goes through the environment so it isn't visible in `ps`.
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: token },
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
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopped && currentToken) spawnTunnel(currentToken);
    }, 5000);
  });

  // Fires instead of 'exit' when cloudflared can't be started at all. Without
  // a listener, the 'error' event would crash the whole server.
  child.on('error', (err) => {
    if (proc !== child) return;
    proc = null;
    status = { state: 'error', message: `Could not start cloudflared: ${err.message}` };
    console.error(`[cloudflared] ${status.message}`);
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
