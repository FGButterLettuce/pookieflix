import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_HLS_CONFIG } from './hlsConfig';

test('desktop HLS keeps a large buffer and retries slow fragments', () => {
  assert.equal(DESKTOP_HLS_CONFIG.maxBufferLength, 60);
  const fragLoadPolicy = DESKTOP_HLS_CONFIG.fragLoadPolicy;
  assert.ok(fragLoadPolicy);
  assert.ok(fragLoadPolicy.default.maxLoadTimeMs >= 120_000);
  assert.ok((fragLoadPolicy.default.timeoutRetry?.maxNumRetry ?? 0) >= 6);
});
