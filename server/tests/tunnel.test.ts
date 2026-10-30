import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('tunnel supervision', () => {
  let dir: string;
  let log: string;
  const originalPath = process.env.PATH;
  let tunnel: typeof import('../src/tunnel');
  const token = 'a'.repeat(60);

  const waitForState = async (state: string) => {
    const deadline = Date.now() + 5000;
    while (tunnel.getTunnelStatus().state !== state) {
      if (Date.now() > deadline) assert.fail(`tunnel never reached ${state}`);
      await new Promise(r => setTimeout(r, 10));
    }
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-tunnel-test-'));
    log = path.join(dir, 'starts.log');
    // First start crashes straight away; later starts stay up until killed.
    const fake = path.join(dir, 'cloudflared');
    fs.writeFileSync(fake, `#!/bin/sh\necho "args=$* token=$TUNNEL_TOKEN" >> "${log}"\nif [ -f "${dir}/crashed" ]; then exec sleep 30; fi\ntouch "${dir}/crashed"\nexit 1\n`);
    fs.chmodSync(fake, 0o755);
    tunnel = await import('../src/tunnel');
  });

  after(() => {
    tunnel.stopTunnel();
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a pending crash restart does not spawn a second connector after a manual reconnect', async () => {
    process.env.PATH = `${dir}:${originalPath}`;
    tunnel.startTunnel(token);
    await waitForState('error'); // crashed, with its restart now pending
    assert.equal(tunnel.reconnectTunnel(), true);
    await new Promise(r => setTimeout(r, 5400));
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
    tunnel.stopTunnel();
  });

  it('passes the token through the environment, not the command line', () => {
    const [line] = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(line, `args=tunnel --no-autoupdate run token=${token}`);
  });

  it('reports a missing cloudflared binary instead of crashing the server', async () => {
    process.env.PATH = path.join(dir, 'nothing-here');
    tunnel.startTunnel('b'.repeat(60));
    await waitForState('error');
    assert.match(tunnel.getTunnelStatus().message ?? '', /Could not start cloudflared/);
  });
});
