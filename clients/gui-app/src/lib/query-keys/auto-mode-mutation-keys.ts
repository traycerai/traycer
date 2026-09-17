/**
 * Write keys for the `auto` permission mode's two host-scoped settings
 * (`autoJudge.set`, `autoPolicy.set`).
 *
 * Their own namespace rather than a corner of `configMutationKeys`: both are
 * optional-capability methods a host may not advertise at all, and the policy
 * one is not even a host file - it proxies an account record on
 * traycer-server. Keeping them apart means a queued policy save is never
 * mistaken for a machine-config write when the two are inspected together.
 */
export const autoModeMutationKeys = {
  setJudge: () => ["autoJudge.set"] as const,
  setPolicy: () => ["autoPolicy.set"] as const,
};
