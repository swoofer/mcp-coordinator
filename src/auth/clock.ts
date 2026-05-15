// Clock seam — shared foundation for time-sensitive auth modules.
// Tests inject a FakeClock; production uses realClock.
// All times are UNIX seconds (epoch-int), matching Phase 2 SQL convention
// (strftime('%s','now') integers, not ISO strings).
export interface Clock {
  // Seconds since UNIX epoch.
  now(): number;
}

export const realClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
};
