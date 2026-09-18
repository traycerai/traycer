import {
  scopedHostReadiness,
  type ScopedHostReadiness,
} from "@/components/settings/host-scope/scoped-host-readiness";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

// The picker's MODEL, apart from its components: fast refresh only keeps state
// for a module that exports components alone, and this file is what the stage
// gates and the page's selection logic import.

/** One device selection shared by the provider and import screens. */
export interface OnboardingHostPicker {
  readonly scope: HostScope;
  /**
   * Selects the device whose providers and sessions the tour reads.
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
