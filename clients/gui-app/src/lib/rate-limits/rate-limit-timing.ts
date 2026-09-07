/**
 * Shared background cadence for the `ephemeralProcess` rate-limit lane (codex, claude-code).
 * `rate-limit-queue-provider.tsx`'s poll interval and `ephemeral-fetch-queue.ts`'s post-`usage_fetch_failed` cool-down both key off this same value - a tripped server-side rate limit should drain over exactly one skipped poll.
 */
export const EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long the GUI waits for a `host.getRateLimitUsage` response frame on the `ephemeralProcess` lane before abandoning the request.
 * The transport's default frame timeout is 30s, which is exactly the host's *default* probe budget - and a Claude Code usage probe legitimately runs longer than that: env resolution has its own 30s budget, a refresh-likely token gets a 90s probe budget.
 */
export const RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;

/** How long after giving up on a `host.getRateLimitUsage` response the queue waits before reading again. */
export const RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS = 90 * 1000;

/**
 * Consecutive follow-ups allowed per target before the queue stops.
 * One is enough to collect a probe that outran its budget; more would turn a host that never answers into a poll loop, and the 15-minute sweep already covers that case.
 */
export const RATE_LIMIT_READ_FOLLOW_UP_LIMIT = 1;
