/**
 * Exponential backoff schedule shared by the streaming reconnect loop
 * (`WsStreamClient`) and the unary transport-retry wrapper
 * (`createRetryingMessenger`). Kept in one place so both paths escalate
 * identically and tests can assert the exact sequence.
 */
export function backoffFor(
  attempt: number,
  initialMs: number,
  maxMs: number,
): number {
  if (attempt <= 0) {
    return initialMs;
  }
  const exponent = Math.min(attempt, 30);
  const candidate = initialMs * Math.pow(2, exponent);
  if (!Number.isFinite(candidate)) {
    return maxMs;
  }
  return Math.min(candidate, maxMs);
}

/**
 * `backoffFor` with full ("equal") jitter folded in: the base delay is scaled
 * by a random factor in `[0.5, 1)` so a fleet of clients that all dropped on
 * the same host blip re-dial on a spread of timers instead of a synchronized
 * thundering herd. `random` returns a value in `[0, 1)` (injected so tests stay
 * deterministic).
 */
export function jitteredBackoffFor(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number,
): number {
  const base = backoffFor(attempt, initialMs, maxMs);
  return Math.round(base * (0.5 + random() * 0.5));
}
