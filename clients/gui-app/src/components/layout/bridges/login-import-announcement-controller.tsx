import { useEffect } from "react";
import { toast } from "sonner";
import { ActionToastContent } from "@/components/layout/bridges/action-toast-content";
import {
  gateBlocksApp,
  useHostReadinessController,
  useSurfaceReadiness,
  windowNarratorOwns,
} from "@/components/layout/host-readiness-controller-context";
import { useLoginImportAvailable } from "@/hooks/browser/use-login-import-available";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useBrowserFocusStore } from "@/stores/settings/browser-focus-store";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";

const LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID = "traycer-login-import-announcement";

/**
 * Tells a user who already finished onboarding that this release can import
 * their browser logins - once, ever, per install.
 *
 * The toast shows on the first launch where ALL of these hold, and showing
 * it consumes the `login-import` announcement (`feature-announcements-store`)
 * so it never shows again and the tour act never follows it:
 *
 * - the import is available here: a desktop with a browser bridge and saved
 *   logins ON (web and mobile have no jar to import into; with saving off
 *   the Settings row is disabled, and a toast leading to a disabled row is
 *   worse than none);
 * - the user is signed in and has COMPLETED onboarding - a fresh user meets
 *   the feature as an act in the tour instead, which consumes the same id;
 * - the tour is not on screen (a replay from Settings), for the reason the
 *   session-import progress toast holds: a toast over the stage is noise;
 * - the window narrator does not own the frame with the app gated behind
 *   its dialog, where a toast renders dead (`pointer-events: none`) and
 *   could never be dismissed - the same predicate the app-update toast
 *   reads, so the two cannot disagree. Held, not dropped: the effect re-runs
 *   when the narrator releases.
 *
 * The primary action arms the one-shot intent BEFORE navigating, so the row
 * that mounts on the General section finds it armed and opens the dialog;
 * "Later" just dismisses - the announcement is consumed either way.
 */
export function LoginImportAnnouncementController(): null {
  const available = useLoginImportAvailable();
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const onboardingComplete = useOnboardingStore(
    (state) => state.completedAt !== null,
  );
  const tourOpen = useOnboardingTourOpenStore((state) => state.open);
  const consumed = useFeatureAnnouncementsStore((state) =>
    isFeatureAnnouncementConsumed(state.consumed, "login-import"),
  );
  const consume = useFeatureAnnouncementsStore((state) => state.consume);
  const readiness = useSurfaceReadiness("default-host", null);
  const { hasBeenDefaultHostReady } = useHostReadinessController();
  const narrated =
    windowNarratorOwns(readiness) &&
    !gateBlocksApp({
      readiness,
      hasBeenReady: hasBeenDefaultHostReady,
      signedIn,
      bypassed: false,
    });

  useEffect(() => {
    if (consumed || !available || !signedIn || !onboardingComplete) return;
    if (tourOpen || narrated) return;
    consume("login-import");
    toast(
      <ActionToastContent
        toastId={LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID}
        eyebrow="New in this release"
        title="Bring your logins with you"
        description="Import the sites you're signed into in Chrome, Edge, Brave, Firefox, or Safari, so agents work on them as you."
        actionLabel="Import logins…"
        onAction={() => {
          useBrowserFocusStore.getState().requestImportLogins();
          navigateToSettingsSection("general");
        }}
        onLater={null}
      />,
      {
        id: LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID,
        description: null,
        duration: Infinity,
        cancel: null,
      },
    );
  }, [
    available,
    consume,
    consumed,
    narrated,
    onboardingComplete,
    signedIn,
    tourOpen,
  ]);

  return null;
}
