import type { Clock } from './clock.ts';

/** Deterministic clock for tests, simulations and replays (§32 T-REPLAY). */
export class FixedClock implements Clock {
  private current: number;
  constructor(startMs: number) {
    this.current = startMs;
  }
  nowMs(): number {
    return this.current;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
