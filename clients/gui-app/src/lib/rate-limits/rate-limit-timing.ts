/**
 * Background cadence for the `ephemeralProcess` rate-limit lane (codex,
 * claude-code, grok): how often `rate-limit-poll-provider.tsx` asks for every
 * fetch-eligible target. A standalone leaf module (no other imports) so the
 * poll and its tests share the constant without an import cycle.
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
 * Three minutes covers env + refresh-safe probe + teardown (150s) with margin.
 * Must equal the `joinResponseTimeoutMs` declared for `host.getRateLimitUsage`
 * in `host-method-policy-table.ts` - the host client rejects any other value.
 *
 * Two waits are deliberately NOT inside this budget: the custodian's hold on
 * the per-config-dir gate, and the host's per-provider probe slot, which a read
 * can wait on behind other profiles' probes (Claude runs one at a time per
 * host). Sizing for either would mean a refresh control that can legitimately
 * spin for many minutes, which is worse UX than the failure it prevents. What
 * makes the overflow acceptable is that it is self-healing rather than lost:
 * the host captures a completed probe into its gauge cache regardless of
 * whether this client was still waiting for the frame, and
 * `fetchProviderRateLimits` collects it once, after
 * `RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS`.
 */
export const RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How long after giving up on a `host.getRateLimitUsage` response
 * `fetchProviderRateLimits` waits before its one collection read.
 *
 * Sized from the overflow the budget above deliberately excludes: a
 * same-profile custodian can hold the per-config-dir gate for roughly two
 * minutes before the 150s of probe phases even begin, so a healthy probe can
 * run to ~270s against a 180s budget. Ninety seconds covers that remainder, by
 * which point the host has usually captured the finished probe in its gauge
 * cache and can answer immediately; a read still in flight on the host is
 * joined rather than started again.
 *
 * The collection travels as `force: false` on purpose - it wants the reading
 * the abandoned probe already produced, not a second subprocess. There is
 * exactly one: more would turn a host that never answers into a poll loop, and
 * the 15-minute poll already covers that case.
 */
export const RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS = 90 * 1000;
