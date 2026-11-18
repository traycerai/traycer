/**
 * Background cadence for the `ephemeralProcess` rate-limit lane (codex,
 * claude-code, grok): how often `rate-limit-poll-provider.tsx` asks for every
 * fetch-eligible target. A standalone leaf module (no other imports) so the
 * poll and its tests share the constant without an import cycle.
 */
export const EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long the strip waits before the ONE re-read it makes for an account whose
 * latest attempt failed transiently with no reading retained behind it - the
 * `transient` segment state, which says so and promises a retry.
 *
 * It exists because the next automatic attempt would otherwise be the poll's,
 * up to `EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS` away, and a segment that says
 * it is retrying has to be retrying. One, not a loop: a re-read that fails
 * again leaves the segment exactly as it was, and the poll owns the cadence
 * from there.
 *
 * It travels as `force: false`, so the host's own read floors decide whether
 * anything is actually read. That is the whole reason this needs no knowledge
 * of them: a `timeout` is past the ephemeral floor by the time this fires and
 * really reads again, while a Claude `usage_fetch_failed` is inside the long
 * penalty window that floor applies to a 429 and is answered from the gauge.
 */
export const TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS = 60 * 1000;

/**
 * How long the strip withholds a `transient` segment's retry affordance after a
 * read of that account was asked for by hand.
 *
 * What protects a provider from a flood is the host: its per-scope single
 * flight coalesces concurrent reads, its usage-probe gate caps how many run at
 * once, and its read floors cover every automatic caller. A forced read is the
 * one caller that passes those floors on purpose, because a person asking is
 * not an automatic caller - so the bound on asking belongs here, where the
 * asking happens.
 *
 * Deliberately a flat bound rather than a reading of the host's floors: those
 * are per provider and per reason, and a second opinion about them here would
 * drift from the first. 60s is the shortest floor the ephemeral lane puts on an
 * automatic read, so a hand-driven retry is never more frequent than the
 * background one.
 */
export const RATE_LIMIT_MANUAL_RETRY_WITHHOLD_MS = 60 * 1000;

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
