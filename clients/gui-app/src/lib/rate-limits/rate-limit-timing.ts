/**
 * Shared background cadence for the `ephemeralProcess` rate-limit lane
 * (codex, claude-code). `rate-limit-queue-provider.tsx`'s poll interval and
 * `ephemeral-fetch-queue.ts`'s post-`usage_fetch_failed` cool-down both key
 * off this same value - a tripped server-side rate limit should drain over
 * exactly one skipped poll. A standalone leaf module (no other imports) lets
 * both sides import the same constant without a cross-import cycle between
 * them.
 */
export const EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS = 15 * 60 * 1000;
