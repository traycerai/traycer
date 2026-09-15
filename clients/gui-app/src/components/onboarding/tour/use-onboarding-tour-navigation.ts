import { useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  getActivationToken,
  subscribeActivation,
} from "@/components/onboarding/tour/tour-activation";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  draftTabIntent,
  newDraftTabIntent,
} from "@/lib/tab-navigation/intents";
import {
  isOpenLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  selectActiveStep,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import type { TourId } from "@/stores/onboarding/onboarding-tour-catalog";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * Entry navigation for the landing lessons, once per activation of the
 * chain: they need the landing draft surface (Home has no composer, and
 * the imported-sessions list the history lesson points at lives there
 * too), so when the chain becomes active on a landing lesson and the
 * focused surface is not a draft - a Settings tab replaying a lesson, an
 * epic restored at launch - the tour goes there through the tab-navigation
 * seam: the saved draft if it is still open, else a new one. The seam
 * queues until tab hydration, so a relaunch that restores a paused
 * checkpoint lands correctly too. The controller then captures the
 * concrete draft the seam selected (`context.draftId`) from the focused
 * ref.
 *
 * Once, and only on activation: this is entry/resume work, never an effect
 * that pulls a user back to the draft every time they navigate away. The
 * panels lesson WAITS for its epic surface instead (contract 9) - the
 * tour never creates a task, and opens one only on a gesture of the
 * user's (Next on the history lesson, the card's "Open latest task"; see
 * the controller), never to satisfy an anchor on its own. "Once" is
 * kept module-level, keyed by the activation token: the host remounts on
 * every readiness drop, and a remount must not redirect a lesson already
 * under way (a pending terminal Start mid-flight) back to the draft.
 */

const LANDING_TOURS: ReadonlyArray<TourId> = [
  "add-folder",
  "terminal-mode",
  "submit-prompt",
  "history",
];

let navigatedForActivation: number | null = null;

export function resetTourNavigationForTests(): void {
  navigatedForActivation = null;
}

export function useOnboardingTourNavigation(): void {
  const navigate = useNavigate();
  const chainActive = useOnboardingFlowStore(
    (state) => state.chain === "active",
  );
  const activeTourId = useOnboardingFlowStore((state) => state.activeTourId);
  // One navigation per ACTIVATION (`tour-activation.ts`): a chain start, a
  // launch resume or a replay - a same-tour replay while active included.
  const activation = useSyncExternalStore(
    subscribeActivation,
    getActivationToken,
    getActivationToken,
  );

  useEffect(() => {
    if (!chainActive || navigatedForActivation === activation) return;
    const flow = useOnboardingFlowStore.getState();
    const active = selectActiveStep(flow);
    if (active === null || !LANDING_TOURS.includes(active.tourId)) return;
    navigatedForActivation = activation;

    const focused = selectHostFocusedRef(useTabsStore.getState());
    const drafts = useLandingDraftStore.getState().drafts;
    const isOpenDraft = (id: string): boolean =>
      drafts.some((draft) => draft.id === id && isOpenLandingDraft(draft));
    const savedDraftId = flow.context?.draftId ?? null;
    // Already on a live draft: reuse it, whatever the checkpoint saved.
    if (
      focused !== null &&
      focused.kind === "draft" &&
      isOpenDraft(focused.id)
    ) {
      if (savedDraftId !== focused.id) flow.setContext({ draftId: focused.id });
      return;
    }
    if (savedDraftId !== null && isOpenDraft(savedDraftId)) {
      activateTabIntent(navigate, draftTabIntent(savedDraftId), undefined);
      return;
    }
    // The saved draft is closed or gone: never recreate it under its old id.
    // A fresh draft through the seam; the controller re-captures the id the
    // seam selects, so a stale one is cleared here.
    if (savedDraftId !== null) flow.setContext({ draftId: null });
    activateTabIntent(navigate, newDraftTabIntent(null), undefined);
  }, [chainActive, activeTourId, activation, navigate]);
}
