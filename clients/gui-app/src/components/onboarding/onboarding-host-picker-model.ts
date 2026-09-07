import {
  scopedHostReadiness,
  type ScopedHostReadiness,
} from "@/components/settings/host-scope/scoped-host-readiness";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

// The picker's model, apart from its components: fast refresh only keeps state for a module that exports
// components alone, and this file is what the stage gates and the page's selection logic import.

/** It is held in the page's own state rather than in a store, because it is a choice about this tour and must
 * not outlive it or leak into Settings. */
export interface OnboardingHostPicker {
  readonly scope: HostScope;
  /** The page saves the current host's guide draft first - see `selectHost` in `onboarding-page.tsx` - so this is
   * never a bare setter. */
  readonly onSelectHost: (hostId: string) => void;
  /** The user named a host, rather than following whichever host the tour opened on. */
  readonly hasExplicitPick: boolean;
  /** A second question from `scope.status`, and the tour is wrong without it: `useScopedStreamBinding` fills its
   * binding in an effect, so for at least the commit after a pick. */
  readonly streamOnPickedHost: boolean;
}

/** The rule is the one every surface with its own host picker applies (`scopedHostReadiness`); the tour only
 * supplies its picker's three inputs. */
export function onboardingHostReadiness(
  picker: OnboardingHostPicker,
): ScopedHostReadiness {
  return scopedHostReadiness(picker);
}

export function onboardingHostIsUsable(picker: OnboardingHostPicker): boolean {
  return onboardingHostReadiness(picker) === "ready";
}
