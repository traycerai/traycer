import {
  scopedHostReadiness,
  type ScopedHostReadiness,
} from "@/components/settings/host-scope/scoped-host-readiness";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

// The picker's MODEL, apart from its components: fast refresh only keeps state
// for a module that exports components alone, and this file is what the stage
// gates and the page's selection logic import.

/**
 * The tour's host selection: ONE pick for the whole tour, shown identically on
 * the two acts that read a real machine - session import and the agent guide.
 *
 * It is held in the page's own state rather than in a store, because it is a
 * choice about this tour and must not outlive it or leak into Settings.
 */
export interface OnboardingHostPicker {
  readonly scope: HostScope;
  /**
   * Commits a new pick. The page saves the current host's guide draft FIRST -
   * see `selectHost` in `onboarding-page.tsx` - so this is never a bare setter.
   */
  readonly onSelectHost: (hostId: string) => void;
  /**
   * The user named a host, rather than following whichever host the tour
   * opened on.
   */
  readonly hasExplicitPick: boolean;
  /**
   * The stream transport under the tour is dialing the host the bar NAMES.
   *
   * A second question from `scope.status`, and the tour is wrong without it:
   * `useScopedStreamBinding` fills its binding in an EFFECT, so for at least
   * the commit after a pick - and for as long as that transport is null or
   * closed - the subtree is still on the ambient stream while the scope has
   * already resolved to the new host. The scan, the wizard and the run it
   * starts all ride that transport, so rendering through the gap would list
   * host A's sessions, and import them, under host B's name.
   */
  readonly streamOnPickedHost: boolean;
}

/**
 * What a stage may show: its live content, a spinner, or a dead end. The rule
 * is the one every surface with its own host picker applies
 * (`scopedHostReadiness`); the tour only supplies its picker's three inputs.
 */
export function onboardingHostReadiness(
  picker: OnboardingHostPicker,
): ScopedHostReadiness {
  return scopedHostReadiness(picker);
}

/** Whether the stages may show their live content. */
export function onboardingHostIsUsable(picker: OnboardingHostPicker): boolean {
  return onboardingHostReadiness(picker) === "ready";
}
