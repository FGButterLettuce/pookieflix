import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectLocalRequest, rateLimitKey } from '../src/clientIp';

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });

describe('rateLimitKey', () => {
  const cases: [string, ReturnType<typeof req>, string][] = [
    ['uses Cloudflare\'s client IP from a local cloudflared hop', req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), '198.51.100.7'],
    ['uses the hop appended by a local proxy, not the client-supplied start', req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), '198.51.100.7'],
    ['ignores forwarding headers from a public peer', req('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' }), '203.0.113.9'],
    ['normalizes IPv4-mapped peers', req('::ffff:203.0.113.9'), '203.0.113.9'],
    ['falls back to the LAN peer without proxy headers', req('192.168.0.20'), '192.168.0.20'],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => assert.equal(rateLimitKey(input), want));
  }
});

describe('isDirectLocalRequest', () => {
  const cases: [string, ReturnType<typeof req>, boolean][] = [
    ['loopback', req('127.0.0.1'), true],
    ['IPv6 loopback', req('::1'), true],
    ['class A LAN', req('10.1.2.3'), true],
    ['docker bridge', req('172.17.0.1'), true],
    ['class C LAN', req('::ffff:192.168.0.20'), true],
    ['just outside the 172.16/12 range', req('172.32.0.1'), false],
    ['public peer', req('203.0.113.9'), false],
    ['cloudflared forwarding a public visitor', req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' }), false],
    ['a local reverse proxy', req('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), false],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => assert.equal(isDirectLocalRequest(input), want));
  }
});
