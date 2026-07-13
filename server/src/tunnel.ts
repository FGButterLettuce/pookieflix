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

let proc: ChildProcess | null = null;
let currentToken: string | null = null;
let stopped = true;

function killCurrent(): void {
  if (proc) {
    proc.removeAllListeners('exit');
    proc.kill('SIGTERM');
    proc = null;
  }
}

function spawnTunnel(token: string): void {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', token], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc = child;

  child.stdout?.on('data', d => console.log(`[cloudflared] ${d.toString().trim()}`));
  child.stderr?.on('data', d => console.log(`[cloudflared] ${d.toString().trim()}`));

  child.on('exit', (code, signal) => {
    if (proc !== child) return; // already superseded by a newer spawn
    proc = null;
    if (stopped) return;
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
  killCurrent();
}

export function isTunnelRunning(): boolean {
  return !stopped && proc !== null;
}
