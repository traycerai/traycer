import type { HostInstallPlatform } from "../manifest/host-install";

/** Ticket 03's rollout fence is owned by the CLI, not by an ambient environment toggle or a caller-supplied flag. The first shipped shape is intentionally shadow-only: it makes the executor code observable and testable while the released legacy update command remains authoritative until Ticket 07's compatibility cutover. */
/** Cohort eligibility is a rollout input, never a caller-built verdict. */
export type UpdateExecutorCohortVerdict =
  | { readonly kind: "shadow"; readonly reason: "disabled" }
  | {
      readonly kind: "eligible";
      readonly platform: HostInstallPlatform;
    };

export function decideUpdateExecutorCohort(
  _platform: HostInstallPlatform,
): UpdateExecutorCohortVerdict {
  // This is intentionally static release policy, not a test-only runtime switch.
  // Ticket 07 is the only authorized cutover point.
  return { kind: "shadow", reason: "disabled" };
}
