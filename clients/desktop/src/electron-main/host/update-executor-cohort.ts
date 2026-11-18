/**
 * Ticket 05's rollout fence for the packaged-macOS Desktop executor.
 *
 * Deliberately a mirror of the CLI's `decideUpdateExecutorCohort`, and
 * deliberately a SEPARATE decision rather than a call into it: the two cohorts
 * gate different executors, keyed on different facts — this one on the resolved
 * service SUBSTRATE, the CLI's on the install PLATFORM — and Ticket 07 cuts
 * them over independently.
 *
 * The original reason given here was that the CLI's `eligible` arm was typed
 * `Exclude<HostInstallPlatform, "darwin">` and so could not represent this
 * executor's platform. That is no longer true: Ticket 05 widened that arm (the
 * exclusion had made darwin unrepresentable even with the cohort mocked, so the
 * path could not be covered at all). The separation is still correct; the
 * type-level reason for it is not, and a stale reason is worse than none —
 * it invites someone to "fix" the duplication once they notice the premise
 * no longer holds.
 *
 * The shipped branch is static `shadow/disabled` for every owner. There is no
 * environment toggle, no setter, and no runtime switch: Ticket 07 is the only
 * authorized cutover point, and a fence that a test or a support flag can flip
 * is not a fence. Keeping the decision as a function is what lets every
 * executor entry point carry one explicit gate while the shipped branch stays
 * incapable of selecting schema-v2 work.
 *
 * Tests exercise the real executor by mocking THIS module (the
 * `vi.importActual` + `mockImplementation` pattern the CLI's executor suite
 * uses), never by adding a production seam here.
 */

import type { HostServiceSubstrate } from "./host-owner";

export type DesktopUpdateExecutorCohortVerdict =
  | { readonly kind: "shadow"; readonly reason: "disabled" }
  | {
      readonly kind: "eligible";
      /**
       * Only a positively attested SMAppService owner can ever select the
       * Desktop executor. `raw-fallback` belongs to the CLI executor and
       * `unknown` is fail-closed, so neither is representable here — the
       * caller must have resolved a concrete owner before it can even ask.
       */
      readonly substrate: Extract<HostServiceSubstrate, "smappservice">;
    };

/**
 * ## What the cutover MUST bring with it
 *
 * §9.1 lists the preconditions for enabling new execution for a cohort, and one
 * of them has no consumer today BY DESIGN — recorded here because this function
 * is the only place that can arm it:
 *
 * > Desktop must verify host transaction capability before local
 * > apply/activation.
 *
 * `host.status@1.3`'s `updateTransaction` is that capability. It is currently
 * carried as evidence (`FleetUpdateWireObservation.transaction`) and gates
 * nothing, which is correct while this returns `shadow`: §9.1 requires an
 * unverifiable combination to CONTINUE the legacy path while the new authority
 * is disabled, and every pre-1.3 host — today, the whole deployed fleet —
 * reports `null` here. A gate wired now would refuse to update exactly those
 * hosts.
 *
 * So when this function starts returning `eligible`, the same change must make
 * `applyStaged`/`activateInstalled` refuse a host whose `updateTransaction` is
 * `null` or whose `authority` is not `attempt`, for the cohort it just enabled.
 * Enabling the cohort without that gate reopens the mixed-version race the
 * signal exists to close — one legacy and one new authority, concurrently,
 * which §9.1 forbids outright.
 */
export function decideDesktopUpdateExecutorCohort(
  _substrate: HostServiceSubstrate,
): DesktopUpdateExecutorCohortVerdict {
  return { kind: "shadow", reason: "disabled" };
}
