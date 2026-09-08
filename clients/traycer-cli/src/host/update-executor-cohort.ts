import type { HostInstallPlatform } from "../manifest/host-install";

/**
 * Ticket 03's rollout fence is owned by the CLI, not by an ambient environment
 * toggle or a caller-supplied flag. The first shipped shape is intentionally
 * shadow-only: it makes the executor code observable and testable while the
 * released legacy update command remains authoritative until Ticket 07's
 * compatibility cutover.
 */
/**
 * Two different questions live in this type, and keeping them apart is the
 * point of its current shape.
 *
 * The eligible verdict's **shape** describes executor *capability* — which
 * platforms this executor is structurally able to run on. Rollout **selection**
 * — which platforms it is actually permitted on today — lives solely in
 * `decideUpdateExecutorCohort` below, and in Ticket 07.
 *
 * The arm was previously typed `Exclude<HostInstallPlatform, "darwin">`. That
 * encoded a rollout decision in a type, and the consequence was worse than a
 * disabled path: once packaged-macOS verification was delegated to a CLI
 * claimant (Ticket 05), darwin became not merely ineligible but
 * **unrepresentable** — a test could not construct an eligible darwin verdict
 * even with the cohort mocked, and the repo bans the casts that would force
 * one. The path would have shipped with no possible coverage.
 *
 * Widening the arm restores expressibility and changes no runtime behaviour:
 * the function still returns static `shadow` for darwin and for every other
 * shipped platform. Landed under Ticket 05 with the T2/T3 author's explicit
 * baseline sign-off, whose finding was that the exclusion was "rollout
 * sequencing encoded too deeply in the verdict type", not an authority or
 * platform-safety invariant.
 */
export type UpdateExecutorCohortVerdict =
  | { readonly kind: "shadow"; readonly reason: "disabled" }
  | {
      readonly kind: "eligible";
      readonly platform: HostInstallPlatform;
    };

export function decideUpdateExecutorCohort(
  platform: HostInstallPlatform,
): UpdateExecutorCohortVerdict {
  // THE CUTOVER. This is intentionally static release policy, not a test-only
  // runtime switch: `host update` now runs every arm on the attempt executor
  // from `host/update-run.ts`, on every shipped platform, and the shadow
  // verdict this used to return would refuse the command outright.
  //
  // Keeping the decision as a function - rather than deleting the gate - is
  // what leaves one explicit, mockable place for a future rollout to narrow,
  // and what keeps every caller's `!== "eligible"` arm reachable in tests.
  return { kind: "eligible", platform };
}
