import { useMemo } from "react";
import {
  buildHostProgressView,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";

/**
 * What this machine's host controller is currently doing, read from the
 * MUTATION LANE and from nothing else.
 *
 * ACTOR-AGNOSTIC BY CONSTRUCTION, which is the whole point of the hook. The
 * lane belongs to the `HostController`, and it publishes identically whichever
 * actor asked: the desktop's launch reconciler installing a first-ever host,
 * the selection authority's `LocalHostEnsurePort` ensure, or a user clicking
 * Retry. A surface that instead reads its OWN mutation observer
 * (`convergeReady.isPending && lane.kind === "ensure" ? lane.progress : null`,
 * which is still how the legacy install card derives it) can only ever see the
 * episodes it started - so a first launch, where the desktop is the actor,
 * renders a blank card while a real install is streaming progress underneath.
 * That read is recorded as a known-interim hazard and dies with the wrapper it
 * lives in; this hook is what replaces it, and it deliberately shares no state
 * with any renderer-side mutation.
 *
 * Every lane kind is reported, not just `ensure`. The window narrator's job is
 * to say what is happening about a window nothing can serve, and "Restarting
 * Traycer Host…" or "Applying the host update…" answers that as well as
 * "Setting up Traycer Host…" does. The copy table is total over the kinds, so
 * there is no arm this can surface without wording.
 *
 * `null` means no lane is running - not "no progress yet". A lane that has
 * been accepted but has not pushed an event still returns a view with its
 * heading, which is what keeps an accepted-but-silent install from reading as
 * a frozen app.
 */
export function useHostProvisioningProgress(): HostProgressView | null {
  const status = useRunnerHostControllerStatusQuery();
  const lane = status.data?.mutation ?? null;
  return useMemo(() => buildHostProgressView(lane), [lane]);
}
