import type { HlsConfig } from 'hls.js';

// Desktop browsers use hls.js rather than Safari's native HLS player. Keep a
// Safari-sized runway and tolerate a transiently slow tunnel long enough for
// retries or the server's automatic tunnel recovery to take effect.
export const DESKTOP_HLS_CONFIG: Partial<HlsConfig> = {
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 20_000,
      maxLoadTimeMs: 180_000,
      timeoutRetry: {
        maxNumRetry: 6,
        retryDelayMs: 1_000,
        maxRetryDelayMs: 8_000,
      },
      errorRetry: {
        maxNumRetry: 6,
        retryDelayMs: 1_000,
        maxRetryDelayMs: 8_000,
      },
    },
  },
};
