/**
 * The reason vocabulary of the two BOUND update dispatches,
 * `host.update.activate` and `host.update.continue` — every value that can
 * appear as `reason` on a `dispatch-indeterminate` / `cli-failed` response, or
 * on the ACK's `no-attempt` result.
 *
 * ## This is a VOCABULARY pin, not a schema
 *
 * Neither wire shape enumerates these. The RPC response's `reason` is
 * `z.string().min(1)` (`../host/maintenance/schemas.ts`) and the ACK's is a
 * kebab PATTERN, not an enum (`./host-update-ack.ts`). Both stay that way
 * deliberately: a host must be able to report a reason a client predates, and
 * an enum on the wire would turn "a newer host said something new" into a
 * parse failure at exactly the moment the user needs to be told something.
 *
 * So nothing here validates a wire value. What it does is give the three
 * surfaces ONE list to agree over:
 *
 *  - `traycer-host` derives its `BOUND_DISPATCH_REASONS` from this tuple
 *    rather than declaring its own literals;
 *  - the GUI closes its indeterminate-dispatch arm set over
 *    {@link HostUpdateBoundDispatchReason}, so a reason added here reddens the
 *    renderer until someone writes copy for it;
 *  - the CLI's bound release reasons are drawn from the same names.
 *
 * That is the whole value: an eighth reason added upstream cannot reach a user
 * as an unrendered raw string, because the type says the renderer has to have
 * a branch for it. The wire remaining open is what keeps that a build-time
 * obligation rather than a runtime failure.
 *
 * ## Dependency-free on purpose
 *
 * No zod, no `node:*` — the renderer imports this directly, the same way it
 * imports `./log-level`. `./host-update-ack.ts` could not have hosted it: that
 * module reads `node:path` to resolve the ACK file, which is exactly what a
 * browser bundle must not pull in.
 */

export const HOST_UPDATE_BOUND_DISPATCH_REASONS = [
  /** Updates are supervised by something other than the CLI's canonical service label. */
  "externally-managed",
  /** The record named by the request is absent, terminal, or a DIFFERENT attempt. */
  "refused-attempt-gone",
  /**
   * The record named by the request IS that attempt, at a position the caller
   * did not authorize — it advanced and parked again between the observation
   * the user confirmed and this dispatch.
   *
   * Deliberately not folded into `refused-attempt-gone`. That one says "there
   * is nothing here to act on"; this one says "what is here is not what you
   * were shown", and the only correct response to it is to look again and
   * confirm again. Collapsing the two would hide a consent failure inside a
   * routine one, and would tell a user nothing is happening when something is.
   */
  "refused-attempt-moved",
  /** The record could not be decoded at all, or the observation hit its deadline. */
  "refused-unverifiable",
  /** No CLI invocation could be resolved to dispatch to. */
  "cli-unavailable",
  /** The resolved CLI predates the bound options and would reject them. */
  "cli-too-old",
  /** The spawn itself failed. */
  "spawn-failed",
] as const;

export type HostUpdateBoundDispatchReason =
  (typeof HOST_UPDATE_BOUND_DISPATCH_REASONS)[number];

/**
 * Narrows a wire `reason` to the known vocabulary.
 *
 * A `false` here is NOT an error: it is a newer host naming something this
 * build has no copy for, which the caller should render as a generic
 * indeterminate outcome carrying the raw string rather than dropping. Refusing
 * to display it would lose the only thing the host managed to say.
 */
export function isHostUpdateBoundDispatchReason(
  value: string,
): value is HostUpdateBoundDispatchReason {
  return (HOST_UPDATE_BOUND_DISPATCH_REASONS as readonly string[]).includes(
    value,
  );
}
