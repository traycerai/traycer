/**
 * The three lanes are one capability, and this is where that is enforced.
 * The protocol registry states the rule and gives the reason: a host advertising two of the three is a host that cannot serve an epic at all.
 */

/**
 * The three method names, in one place so a selector cannot check two of them.
 * A tuple rather than three exported constants: the failure this module exists to prevent is checking a subset, and a subset is what three separate constants invite at every call site.
 */
export const EPIC_LANE_METHODS = [
  "epic.state.subscribe",
  "epic.status.subscribe",
  "artifact.subscribe",
] as const;

/**
 * Whether this connection may take the lane path.
 * `"unknown"` therefore must not be read as a yes: a client that waited for it to resolve would wait for nothing, and one that took it as support would open three lanes against a host that answers none of them.
 */
export function hostServesEpicLanes(
  support: (method: string) => "unknown" | "supported" | "unsupported",
): boolean {
  return EPIC_LANE_METHODS.every((method) => support(method) === "supported");
}
