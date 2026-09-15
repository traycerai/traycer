import { useEffect, useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";
import { TRAYCER_GITHUB_URL } from "@/lib/onboarding-links";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingFlowStore } from "@/stores/onboarding/onboarding-flow-store";
import {
  selectOnboardingBusy,
  useOnboardingPresenceStore,
} from "@/stores/onboarding/onboarding-presence-store";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";
import {
  getSystemTabModalApi,
  useSystemTabModalApiPublished,
} from "@/stores/tabs/system-tab-modal-bridge";

export const ONBOARDING_COMPLETION_TOAST_ID = "traycer-onboarding-completion";

/**
 * "Make yourself at home": once per install, when the chain of tours ends -
 * completed or skipped, never merely paused - and the screen is free.
 *
 * Eligibility, all of which HOLD the toast rather than drop it:
 * - signed in and mounted under the flow host's desktop / host gates;
 * - a REAL chain end is pending (`completionPending`, set by the flow store
 *   when an active or paused chain completes or is skipped and persisted
 *   until acknowledged here). The legacy migration writes a synthetic
 *   `skipped` chain without it, so an old-tour completer never toasts on
 *   upgrade, while their deliberate later replay ending here does - even
 *   if the toast had to be held across a remount or a reload;
 * - nothing of the flow has the screen (`selectOnboardingBusy`: the
 *   welcome modal's presence or a running tour);
 * - the system-tab modal API is published, so "Learn more" has a Settings
 *   to open (`navigateToSettingsSection` no-ops without it).
 *
 * Immediately before showing, the `onboarding-completion` announcement is
 * claimed (`feature-announcements-store`): persisted, so a reload or a later
 * replay never repeats it; the store's documented cross-window race stays
 * accepted.
 */
export function OnboardingCompletionToast(): ReactNode {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const completionPending = useOnboardingFlowStore(
    (state) => state.completionPending,
  );
  const acknowledgeCompletion = useOnboardingFlowStore(
    (state) => state.acknowledgeCompletion,
  );
  const onboardingBusy = useOnboardingPresenceStore(selectOnboardingBusy);
  const apiPublished = useSystemTabModalApiPublished();
  const consumed = useFeatureAnnouncementsStore((state) =>
    isFeatureAnnouncementConsumed(state.consumed, "onboarding-completion"),
  );
  const claim = useFeatureAnnouncementsStore((state) => state.claim);
  const openLink = useOpenLink();

  useEffect(() => {
    if (!completionPending || !signedIn) return;
    if (consumed) {
      // Claimed already (an earlier chain end, or another window): nothing
      // to show, and the pending end is settled.
      acknowledgeCompletion();
      return;
    }
    if (onboardingBusy || !apiPublished) return;
    if (!claim("onboarding-completion")) return;
    acknowledgeCompletion();
    toast(
      <OnboardingCompletionToastContent
        toastId={ONBOARDING_COMPLETION_TOAST_ID}
        onStar={() => {
          void openLink(TRAYCER_GITHUB_URL, "app", null);
        }}
      />,
      {
        id: ONBOARDING_COMPLETION_TOAST_ID,
        description: null,
        duration: Infinity,
        cancel: null,
      },
    );
  }, [
    acknowledgeCompletion,
    apiPublished,
    claim,
    completionPending,
    consumed,
    onboardingBusy,
    openLink,
    signedIn,
  ]);

  return null;
}

/**
 * Two actions, both dispatched at most once (the ref holds inside the same
 * tick, where a second click can land while the toast is on its way out),
 * in the `ActionToastContent` layout - but a dedicated body: that one
 * hardcodes "Later", and neither of these is a later. A plain dismiss is
 * still owed (the toast never times out, and sonner draws no close button
 * on a JSX toast), so an icon close sits in the corner.
 *
 * "Learn more" re-checks that the Settings bridge is still published at
 * click time: if it vanished (a host gate re-closing), the navigation would
 * be lost and the toast is gone, so the button disables instead.
 */
export function OnboardingCompletionToastContent(props: {
  readonly toastId: string;
  readonly onStar: () => void;
}): ReactNode {
  const apiPublished = useSystemTabModalApiPublished();
  const handledRef = useRef(false);
  const [handled, setHandled] = useState(false);

  const dispatch = (action: () => void): void => {
    if (handledRef.current) return;
    handledRef.current = true;
    setHandled(true);
    action();
    toast.dismiss(props.toastId);
  };

  return (
    <div
      className="flex items-center gap-4"
      data-testid="onboarding-completion-toast"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">Make yourself at home</div>
        <div className="mt-1 text-muted-foreground">
          Explore more ways to work with Traycer.
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-1 gap-1.5">
        <Button
          type="button"
          size="sm"
          className="w-full min-w-max"
          disabled={handled}
          onClick={() => {
            dispatch(props.onStar);
          }}
        >
          Star on GitHub
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-full min-w-max"
          disabled={handled || !apiPublished}
          onClick={() => {
            // Same-tick re-check: the subscription above disables the
            // button on the next render, but a click can land first.
            if (getSystemTabModalApi() === null) return;
            dispatch(() => {
              navigateToSettingsSection("onboarding");
            });
          }}
        >
          Learn more
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="-mt-1 -mr-1 shrink-0 self-start"
        aria-label="Dismiss"
        onClick={() => {
          toast.dismiss(props.toastId);
        }}
      >
        <XIcon />
      </Button>
    </div>
  );
}
