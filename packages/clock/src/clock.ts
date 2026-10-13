/** The only source of time (contract §4). Inject it; never call Date.now() or new Date() directly. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
  now(): Date;
}
