export interface TunnelFailureMonitorOptions {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
}

function isHlsFailure(line: string): boolean {
  return line.includes('Request failed')
    && line.includes('/api/hls/')
    && /canceled|timed? out|timeout|connection reset/i.test(line);
}

/**
 * Recognizes a failing Cloudflare media path without reacting to ordinary
 * page/API errors. A rolling threshold prevents a single client-side abort
 * (for example, a seek) from bouncing the tunnel for both viewers.
 */
export class TunnelFailureMonitor {
  private readonly options: TunnelFailureMonitorOptions;
  private failures: number[] = [];
  private lastTriggeredAt = Number.NEGATIVE_INFINITY;

  constructor(options: TunnelFailureMonitorOptions) {
    this.options = options;
  }

  record(line: string, now = Date.now()): boolean {
    if (!isHlsFailure(line)) return false;
    if (now - this.lastTriggeredAt < this.options.cooldownMs) return false;

    const cutoff = now - this.options.windowMs;
    this.failures = this.failures.filter(ts => ts >= cutoff);
    this.failures.push(now);

    if (this.failures.length < this.options.threshold) return false;

    this.failures = [];
    this.lastTriggeredAt = now;
    return true;
  }
}
