// Proxy headers are only meaningful when the TCP peer is a local hop
// (cloudflared, Caddy, the Docker bridge). A public peer can send anything.

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

function peerAddress(req: RequestLike): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address)) return true;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n))) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function header(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

// True only for someone directly on this machine or its LAN. cloudflared also
// connects from loopback, so any proxy header disqualifies the request.
export function isDirectLocalRequest(req: RequestLike): boolean {
  return isPrivateAddress(peerAddress(req)) && !PROXY_HEADERS.some(name => header(req, name) !== undefined);
}

// Clients can prepend whatever they like to X-Forwarded-For and Cloudflare
// keeps it, so only the entries the proxies themselves wrote can be trusted:
// Cf-Connecting-IP (Cloudflare overwrites it), or the last forwarded hop.
export function rateLimitKey(req: RequestLike): string {
  const peer = peerAddress(req);
  if (!isPrivateAddress(peer)) return peer;
  const lastHop = header(req, 'x-forwarded-for')?.split(',').at(-1)?.trim();
  return header(req, 'cf-connecting-ip')?.trim() || lastHop || peer;
}
