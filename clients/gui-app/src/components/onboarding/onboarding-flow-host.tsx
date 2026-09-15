import { useEffect, useState, type ReactNode } from "react";
import { HostScopeReady } from "@/components/layout/host-readiness-controller";
import { OnboardingCompletionToast } from "@/components/onboarding/tour/onboarding-completion-toast";
import { OnboardingTour } from "@/components/onboarding/tour/onboarding-tour";
import { useOnboardingTourNavigation } from "@/components/onboarding/tour/use-onboarding-tour-navigation";
import { wasTourDismissedThisLaunch } from "@/components/onboarding/tour/use-onboarding-tour-controller";
import { WelcomeModal } from "@/components/onboarding/welcome/welcome-modal";
import { isMobileApp } from "@/lib/mobile-app";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  selectChainResumable,
  selectFirstRunModalDue,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";

/**
 * The onboarding flow's mount point (parent contract 9): inside `AppShell`,
 * so it has the router, the dialog primitives and the toaster - the ONE
 * place the first-run welcome modal and the spotlight tours live. Renders
 * nothing until the user is signed in, and never in the installed mobile
 * app (there is no onboarding there after the old tour's removal; a narrow
 * desktop window still gets one).
 *
 * The welcome modal needs no host: it is what gets a user to one. The
 * tours, their launch-time resume, their entry navigation and the
 * completion toast wait for the default host (`HostScopeReady`, the seam
 * the landing terminal mounts behind). The modal (`finishModal` /
 * `skipModal`) is what starts a chain; nothing here starts one - and while
 * the modal is presented its Dialog counts as a presented modal, so the
 * tour holds (`run` false, Esc left to the modal) until it closes.
 *
 * Owns exactly one piece of state the flow store must NOT hold: whether the
 * welcome modal was dismissed with Esc THIS SESSION. The store keeps `modal:
 * "in-progress"` through a pause on purpose - that is what brings the modal
 * back on the next launch - so the "do not reopen right now" fact lives
 * here, in memory, and is released when Settings asks for the modal again
 * (`showWelcomeModalAgain` sets `modal` back to `pending`).
 */
export function OnboardingFlowHost(): ReactNode {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const modalDue = useOnboardingFlowStore(selectFirstRunModalDue);
  const modalPending = useOnboardingFlowStore(
    (state) => state.modal === "pending",
  );
  const [dismissed, setDismissed] = useState(false);
  // Released the moment the store says `pending` again, adjusted during
  // render rather than in an effect: `startModal` moves `pending` back to
  // `in-progress` on the modal's first commit, and a reset that waited for
  // an effect would see that commit with the flag still up.
  if (modalPending && dismissed) setDismissed(false);

  if (!signedIn || isMobileApp()) return null;
  return (
    <>
      {modalDue && !dismissed ? (
        <WelcomeModal onPaused={() => setDismissed(true)} />
      ) : null}
      <HostScopeReady scope="default-host">
        <OnboardingTourHost />
      </HostScopeReady>
    </>
  );
}

function OnboardingTourHost(): ReactNode {
  useOnboardingLaunchResume();
  useOnboardingTourNavigation();
  return (
    <>
      <OnboardingTour />
      <OnboardingCompletionToast />
    </>
  );
}

/**
 * A paused checkpoint resumes on the NEXT launch - once, when this host
 * first mounts ready - and never in the launch that paused it (Esc marks the
 * launch; see `wasTourDismissedThisLaunch`). An active chain needs nothing:
 * its checkpoint is already the live state. Skipped and completed chains
 * never auto-start.
 */
function useOnboardingLaunchResume(): void {
  useEffect(() => {
    if (wasTourDismissedThisLaunch()) return;
    const flow = useOnboardingFlowStore.getState();
    if (!selectChainResumable(flow)) return;
    flow.resumeChain();
  }, []);
}
