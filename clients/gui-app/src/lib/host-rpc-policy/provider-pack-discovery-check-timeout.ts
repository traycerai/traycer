/**
 * How long the GUI waits for a `providers.refreshPackDiscovery` response frame
 * before abandoning the request.
 *
 * The RPC runs the pack-discovery poll the host otherwise only runs on its own
 * jittered ticker, and a tick already in flight is JOINED rather than queued -
 * so the frame this budget covers can be the whole enabled set's poll, not the
 * one pack the user pressed the button for. Sized from that worst case:
 *
 *   15 managed packs (`traycer-host/resources/providers/PROVIDERS.json`)
 *     x 2 registry metadata GETs per pack (an unconditional pointer read, then
 *       a conditional head read)
 *     x 10s per GET (the registry transport's metadata timeout)
 *   = 300s, run serially, with every request burning its full timeout
 *   + 60s margin for the deferred keyring load a manual check may kick, which
 *     is itself signed-metadata reads under that same 10s ceiling
 *   = 360s.
 *
 * The first term is a COUNT, not a constant: re-derive this when a pack is
 * added to `PROVIDERS.json`.
 *
 * Must equal the `joinResponseTimeoutMs` declared for
 * `providers.refreshPackDiscovery` in `host-method-policy-table.ts` - the host
 * client rejects any other value - and the CALLER has to pass it, through
 * `useHostMutationWithResponseTimeout`. A plain `useHostMutation` under that
 * row runs on the transport's 30s default and makes this number inert.
 *
 * Deliberately NOT `RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS`, which is currently
 * the same order of magnitude by coincidence: that one is a CLI-probe budget
 * sized from subprocess phases, and the two would drift for unrelated reasons.
 *
 * A standalone leaf module (no other imports), so the policy table and the
 * mutation hook can share one number without importing each other.
 */
export const PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS = 6 * 60 * 1000;
