import { useEffect, useRef } from "react";
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
import { useSystemTabModalApiPublished } from "@/stores/tabs/system-tab-modal-bridge";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";

const LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID = "traycer-login-import-announcement";

/** The toast shows on the first launch where all of these hold, and showing it claims the `login-import`
 * announcement (`feature-announcements-store`) so it never shows again - in this window or another. */
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
  const claim = useFeatureAnnouncementsStore((state) => state.claim);
  // The action navigates to Settings through the system-tab modal API, which `SystemTabModalHost` publishes only
  // once it is mounted.
  const settingsReachable = useSystemTabModalApiPublished();
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

  // `consumed` cannot stand in for it: the claim flips it the moment the toast shows, and another window's claim
  // flips it with no toast here at all.
  const shownRef = useRef(false);

  useEffect(() => {
    // Not the narrator: that gate is transient, and a toast under its dialog is inert rather than wrong - it comes
    // back live when the dialog goes, the same standing the app-update toast has.
    if (shownRef.current && (!available || !signedIn || tourOpen)) {
      shownRef.current = false;
      toast.dismiss(LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID);
      return;
    }
    if (consumed || !available || !signedIn || !onboardingComplete) return;
    if (tourOpen || narrated || !settingsReachable) return;
    // A claim, not a consume: `consumed` above is this window's copy, and a second window restored alongside this
    // one holds its own.
    if (!claim("login-import")) return;
    shownRef.current = true;
    toast(
      <ActionToastContent
        toastId={LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID}
        eyebrow="New in this release"
        title="Your browser logins, in Traycer"
        description="Import the logins from the browser you already use, so agents work on those sites as you."
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
    claim,
    consumed,
    narrated,
    onboardingComplete,
    settingsReachable,
    signedIn,
    tourOpen,
  ]);

  return null;
}
