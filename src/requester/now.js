// Port of now_other.go.
//
// Go: `var startTime = time.Now()` and `now() = time.Since(startTime)`, a
// monotonic time.Duration in nanoseconds. Date.now() would be wall-clock,
// millisecond-resolution and subject to NTP steps; process.hrtime.bigint() is
// monotonic and already nanoseconds, matching Duration exactly.
//
// now_windows.go exists upstream only to reach QueryPerformanceCounter, because
// Go's monotonic clock had insufficient resolution on Windows. Node's
// hrtime.bigint() is high-resolution on every platform, so the port needs one
// implementation rather than two.

const startTime = process.hrtime.bigint();

/** time.Since(startTime) as BigInt nanoseconds. */
export function now() {
  return process.hrtime.bigint() - startTime;
}
