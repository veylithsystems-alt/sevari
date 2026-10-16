import type { Clock } from './clock.ts';

/** The one place allowed to read wall-clock time (lint rule sevari/no-raw-date exempts this file only). */
export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  now(): Date {
    return new Date();
  }
}
