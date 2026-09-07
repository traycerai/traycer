/**
 * How long the GUI waits for a `providers.refreshPackDiscovery` response frame
 * before abandoning the request.
 *
 * The RPC runs the pack-discovery poll the host otherwise only runs on its own
 * jittered ticker, and a tick already in flight is JOINED rather than queued -
 * so the frame this budget covers can be the whole enabled set's poll, not the
 * one pack the user pressed the button for. Sized from that worst case:
 *
 *   15 managed packs      `traycer-host/resources/providers/PROVIDERS.json`
 *    x 2 signed objects   `readLiveHead` calls `RegistryTransport.getSigned`
 *                         twice - the generation pointer, then the head
 *    x 2 HTTP requests    `HttpRegistryTransport.getSigned` fetches the object
 *                         AND its sibling `<path>.minisig`, sequentially
 *    x 10s per request    each carries its own
 *                         `AbortSignal.timeout(metadataTimeoutMs)`
 *   = 600s, run serially, with every request burning its full timeout
 *   + 60s margin for the deferred keyring load a manual check may kick, which
 *     is itself signed-metadata reads under that same 10s ceiling
 *   = 660s.
 *
 * FOUR timeout windows per pack, not two. The signature fetch is the one that
 * is easy to miss: it is inside `getSigned`, so it does not appear at the two
 * call sites a reader counts. Under-counting it by 2x is exactly how this
 * budget was first written, and the cost is a request that expires while the
 * host is still working - the user sees a timeout on a check that succeeded.
 *
 * Four is the CEILING; steady state is THREE, not two. A 304 returns from
 * `getSigned` before the `.minisig` fetch is issued, so a cached head costs
 * one window rather than two - but only the HEAD read is conditional. The
 * pointer is issued with a null etag (`readLiveHead` calls
 * `transport.getSigned(pointerPath, null)`, and treats a 304 as a hard
 * error), so it can never take that shortcut and always costs both. "A 304
 * halves it" is the wrong reading: a 304 takes a pack from 4 windows to 3.
 *
 * What this budget covers is ONE full-set poll, and that is the shape a press
 * actually lands in: a check that JOINS the scheduled tick is always covered,
 * because the tick polls the whole enabled set. It does NOT cover being made
 * to wait out several runs in a row. The host's acquisition loop releases a
 * waiter after each settled run and has it re-inspect the slot, so a stream
 * of concurrent single-pack checks can park a caller behind a run that did
 * not cover it and then behind whoever takes the slot next - roughly 40s per
 * stacked check (one pack at the ceiling), so two or three queued behind a
 * tick exceed this number. Deliberately not addressed from here: the button
 * is already disabled per popover while a check is pending, and a deadline
 * belongs on the host's acquisition loop, not on the GUI's frame timeout.
 * Read this constant as the one-poll bound it is rather than a guarantee that
 * no press can time out.
 *
 * ZERO SLACK, by design: 15 x 4 x 10s + 60s is exactly 660s, so the sixteenth
 * pack turns the internal mirror pin red the moment it lands. That is the
 * tripwire working, not an oversight - re-derive both numbers when it fires,
 * and do not pad this one to buy headroom, which disarms it silently. The
 * pack count is a COUNT, not a constant. The internal repo pins the other
 * direction - that today's real count still fits inside this number - at
 * `traycer-host/src/domain/providers/__tests__/provider-pack-count-fits-gui-discovery-check-budget.test.ts`.
 *
 * Must equal the `joinResponseTimeoutMs` declared for
 * `providers.refreshPackDiscovery` in `host-method-policy-table.ts` - the host
 * client rejects any other value - and the CALLER has to pass it, through
 * `useHostMutationWithResponseTimeout`. A plain `useHostMutation` under that
 * row runs on the transport's 30s default and makes this number inert.
 *
 * Deliberately NOT `RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS`: that one is a
 * CLI-probe budget sized from subprocess phases, and the two would drift for
 * unrelated reasons.
 *
 * A standalone leaf module (no other imports), so the policy table and the
 * mutation hook can share one number without importing each other.
 */
export const PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS = 11 * 60 * 1000;
