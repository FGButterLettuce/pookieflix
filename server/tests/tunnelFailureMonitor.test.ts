import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelFailureMonitor } from '../src/tunnelFailureMonitor';

describe('TunnelFailureMonitor', () => {
  it('triggers once after a burst of canceled HLS streams and respects its cooldown', () => {
    const monitor = new TunnelFailureMonitor({ threshold: 3, windowMs: 30_000, cooldownMs: 300_000 });
    const failure = 'Request failed error="stream canceled" dest=https://example.test/api/hls/token/seg0001.ts';

    assert.equal(monitor.record(failure, 1_000), false);
    assert.equal(monitor.record(failure, 2_000), false);
    assert.equal(monitor.record(failure, 3_000), true);
    assert.equal(monitor.record(failure, 4_000), false);
    assert.equal(monitor.record(failure, 304_000), false);
    assert.equal(monitor.record(failure, 305_000), false);
    assert.equal(monitor.record(failure, 306_000), true);
  });

  it('ignores non-HLS failures and successful tunnel output', () => {
    const monitor = new TunnelFailureMonitor({ threshold: 1, windowMs: 30_000, cooldownMs: 300_000 });

    assert.equal(monitor.record('Request failed dest=https://example.test/api/library', 1_000), false);
    assert.equal(monitor.record('Registered tunnel connection connIndex=1', 2_000), false);
  });
});
