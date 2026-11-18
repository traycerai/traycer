/**
 * The three lanes are ONE capability, and this is where that is enforced.
 *
 * The protocol registry states the rule and gives the reason: a host
 * advertising two of the three is a host that cannot serve an epic at all. The
 * records lane with no control lane leaves permission, dirtiness and deletion
 * unknowable forever; the control lane with no records lane has nothing to
 * describe; and a body lane without the records lane has no epoch to attach
 * under, because `artifact.subscribe` requires one on its open request and only
 * `epic.state.subscribe` mints the row an open tile comes from.
 *
 * All three are post-v1.0.0 stream methods and therefore implicitly OPTIONAL:
 * the `/stream` handshake checks compatibility PER METHOD at subscribe time, so
 * a host that lacks one is a per-feature degrade rather than a fatal connection
 * error. That is what makes a partial advertisement REACHABLE - a host halfway
 * through a rollout, or a mux transport that answers `"unknown"` for everything
 * - and therefore something the client has to decide about rather than assume
 * away.
 *
 * The degrade is not degraded: a host without these lanes is a host that still
 * serves `epic.subscribe@1`, and the `@1` legacy adapter produces the same read
 * model from the root Y.Doc. So the safe answer is today's behaviour, which is
 * why this predicate is written to fail CLOSED - anything short of all three
 * known-supported takes the legacy path.
 */

/**
 * The three method names, in one place so a selector cannot check two of them.
 *
 * A tuple rather than three exported constants: the failure this module exists
 * to prevent is checking a SUBSET, and a subset is what three separate
 * constants invite at every call site.
 */
export const EPIC_LANE_METHODS = [
  "epic.state.subscribe",
  "epic.status.subscribe",
  "artifact.subscribe",
] as const;

/**
 * Whether this connection may take the lane path.
 *
 * `support` answers per method, in the transport's own three-valued vocabulary:
 * `"supported"`, `"unsupported"`, or `"unknown"` when the handshake has not
 * settled - and a remote mux transport answers `"unknown"` forever, because it
 * resolves an incompatible method as a fatal on the subscribe attempt rather
 * than as a queryable pre-check. `"unknown"` therefore must not be read as a
 * yes: a client that waited for it to resolve would wait for nothing, and one
 * that took it as support would open three lanes against a host that answers
 * none of them.
 */
export function hostServesEpicLanes(
  support: (method: string) => "unknown" | "supported" | "unsupported",
): boolean {
  return EPIC_LANE_METHODS.every((method) => support(method) === "supported");
}
