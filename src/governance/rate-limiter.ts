// Sliding-window rate limiter for write operations.
export class RateLimiter {
  private windowMs: number;
  private maxOps: number;
  private timestamps: number[] = [];

  constructor(maxOpsPerMinute: number) {
    this.maxOps = maxOpsPerMinute;
    this.windowMs = 60_000;
  }

  /** Returns true if the operation is allowed, false if rate-limited. */
  allow(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);

    if (this.timestamps.length >= this.maxOps) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  /** Seconds until the oldest entry expires and a slot opens. */
  retryAfterSeconds(): number {
    if (this.timestamps.length === 0) return 0;
    const oldest = this.timestamps[0];
    return Math.ceil((oldest + this.windowMs - Date.now()) / 1000);
  }
}
