/**
 * How long the GUI waits for a `simulator.open` response frame.
 *
 * `simulator.open { boot: true }` on a cold simulator answers only once the
 * boot has finished, and the host bounds that boot with its own deadline,
 * `SIMULATOR_BOOT_TIMEOUT_MS` in
 * `traycer-host/src/domain/simulator/simulator-service.ts` (three minutes):
 * past it the host answers with an error of its own. A live iOS boot took
 * 37 s, which is already past the transport's 30 s default response budget,
 * so under that default every cold open failed on the client with a frame
 * timeout while the host went on to boot the simulator and record the
 * session - the tile then recovered through the sessions stream, with a
 * spurious failure logged on the way.
 *
 *   180 s   the host's boot deadline, after which it answers anyway
 *  + 30 s   the transport's ordinary response budget, for the work around
 *           the boot: the inventory refresh and the session record
 *  = 210 s
 *
 * So a frame timeout on `simulator.open` is a real failure (a host that has
 * stopped answering), never a boot that is still running, and it may be
 * reported as one.
 *
 * Must equal the `joinResponseTimeoutMs` declared for `simulator.open` in
 * `host-method-policy-table.ts` - the host client rejects any other value -
 * and the CALLER has to pass it, through `useHostMutationWithResponseTimeout`;
 * a plain `useHostMutation` under that row runs on the 30 s default and
 * makes this number inert.
 *
 * A standalone leaf module (no other imports), so the policy table and the
 * mutation hook can share one number without importing each other.
 */
export const SIMULATOR_OPEN_RESPONSE_TIMEOUT_MS = 3 * 60_000 + 30_000;
