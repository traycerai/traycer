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

/**
 * How long the GUI waits for a `host.getRateLimitUsage` response frame on the
 * `ephemeralProcess` lane before abandoning the request. The transport's
 * default frame timeout is 30s, which is exactly the host's *default* probe
 * budget - and a Claude Code usage probe legitimately runs longer than that:
 * env resolution has its own 30s budget, a refresh-likely token gets a 90s
 * probe budget, teardown adds up to 30s of grace, and a same-profile custodian
 * warm-up can hold the per-config-dir gate for a couple of minutes first. Under
 * the default frame timeout every one of those slow-but-successful probes was
 * discarded client-side as a transport error while the host went on to finish
 * it, so a profile behind a slow probe never received the reading it paid for.
 *
 * Three minutes covers env + refresh-safe probe + teardown (150s) with margin,
 * while still bounding how long one wedged probe can hold the serial lane.
 * Must equal the `joinResponseTimeoutMs` declared for `host.getRateLimitUsage`
 * in `host-method-policy-table.ts` - the host client rejects any other value.
 */
export const RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
