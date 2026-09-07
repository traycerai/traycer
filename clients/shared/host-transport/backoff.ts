/**
 * Exponential backoff schedule shared by the streaming reconnect loop (`WsStreamClient`) and the unary transport-retry wrapper (`createRetryingMessenger`).
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

export function jitteredBackoffFor(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number,
): number {
  const base = backoffFor(attempt, initialMs, maxMs);
  return Math.round(base * (0.5 + random() * 0.5));
}
