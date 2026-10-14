import type { Clock } from '@sevari/clock';

/** Rate limiter port. v1 is in-process (one API process per cell); swap for a shared store when scaled out. */
export interface RateLimiter {
  /** Returns true when the request may proceed. */
  take(key: string): boolean;
}

/** Token bucket: `capacity` burst, refilled at `perMinute` tokens a minute. Memory is bounded by `maxKeys`. */
export class TokenBucketLimiter implements RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #clock: Clock;
  readonly #capacity: number;
  readonly #perMs: number;
  readonly #maxKeys: number;
  constructor(clock: Clock, opts: { capacity: number; perMinute: number; maxKeys?: number }) {
    this.#clock = clock;
    this.#capacity = opts.capacity;
    this.#perMs = opts.perMinute / 60_000;
    this.#maxKeys = opts.maxKeys ?? 50_000;
  }
  take(key: string): boolean {
    const now = this.#clock.nowMs();
    let b = this.#buckets.get(key);
    if (!b) {
      if (this.#buckets.size >= this.#maxKeys) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
      b = { tokens: this.#capacity, at: now };
      this.#buckets.set(key, b);
    }
    b.tokens = Math.min(this.#capacity, b.tokens + (now - b.at) * this.#perMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
