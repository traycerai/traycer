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
import {
  selectOnboardingSettled,
  useOnboardingFlowStore,
} from "@/stores/onboarding/onboarding-flow-store";
import {
  selectOnboardingBusy,
  useOnboardingPresenceStore,
} from "@/stores/onboarding/onboarding-presence-store";
import { useBrowserFocusStore } from "@/stores/settings/browser-focus-store";
import { useSystemTabModalApiPublished } from "@/stores/tabs/system-tab-modal-bridge";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";

const LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID = "traycer-login-import-announcement";

/**
 * Tells a signed-in user that this release can import their browser logins -
 * once, ever, per install.
 *
 * For EVERY signed-in capable user, a fresh one included: nothing in the
 * first run shows browser login import any more (it is a lesson on
 * Settings ▸ Onboarding, which this toast's action opens the way to), so
 * the toast is the one announcement of it. What a fresh user gets instead
 * of an exemption is a wait: the toast holds until the onboarding flow is
 * SETTLED - welcome modal done or skipped AND the tour chain completed or
 * skipped; a paused chain still holds - and until neither the welcome modal
 * nor a tour is on screen.
 *
 * The toast shows on the first launch where ALL of these hold, and showing
 * it claims the `login-import` announcement (`feature-announcements-store`)
 * so it never shows again - in this window or another:
 *
 * - the import is available here: a desktop with a browser bridge and saved
 *   logins ON (web and mobile have no jar to import into; with saving off
 *   the Settings row is disabled, and a toast leading to a disabled row is
 *   worse than none);
 * - the user is signed in;
 * - the onboarding flow is settled (`selectOnboardingSettled`), which a
 *   legacy-migrated install is from the start;
 * - neither the welcome modal nor a tour has the screen
 *   (`selectOnboardingBusy`). Held, not dropped - and, once up, a tour
 *   taking the screen takes the toast down, since a toast over a spotlight
 *   is noise;
 * - the window narrator does not own the frame with the app gated behind
 *   its dialog, where a toast renders dead (`pointer-events: none`) and
 *   could never be dismissed - the same predicate the app-update toast
 *   reads, so the two cannot disagree. Held, not dropped: the effect re-runs
 *   when the narrator releases;
 * - Settings is reachable: the system-tab modal API is published, so the
 *   action has somewhere to go (see `settingsReachable` below).
 *
 * The primary action arms the one-shot intent BEFORE navigating, so the row
 * that mounts on the General section finds it armed and opens the dialog;
 * "Later" just dismisses - the announcement is consumed either way. A gate
 * that closes while the toast is up - saving off, sign-out, the flow taking
 * the screen - dismisses it, since it is permanent otherwise; see the effect.
 */
export function LoginImportAnnouncementController(): null {
  const available = useLoginImportAvailable();
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const onboardingSettled = useOnboardingFlowStore(selectOnboardingSettled);
  const onboardingBusy = useOnboardingPresenceStore(selectOnboardingBusy);
  const consumed = useFeatureAnnouncementsStore((state) =>
    isFeatureAnnouncementConsumed(state.consumed, "login-import"),
  );
  const claim = useFeatureAnnouncementsStore((state) => state.claim);
  // The action navigates to Settings through the system-tab modal API, which
  // `SystemTabModalHost` publishes only once it is mounted - behind
  // `HostReadyGate`, so on a cold launch the toast could otherwise show while
  // its action still no-ops: the toast would dismiss itself, consumed, with
  // Settings never opened and the intent left armed for a later visit. Held
  // until the API exists; the effect re-runs when it is published.
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

  // Whether THIS controller put the toast up. `consumed` cannot stand in
  // for it: the claim flips it the moment the toast shows, and another
  // window's claim flips it with no toast here at all.
  const shownRef = useRef(false);

  useEffect(() => {
    // The toast is permanent, so a gate that closes after it is up takes it
    // down: saving turned off (the row its action leads to is disabled), a
    // sign-out, or the onboarding flow taking the screen (a replayed tour's
    // spotlight, and a toast over it is noise). Not the narrator: that gate
    // is transient, and a toast under its dialog is inert rather than wrong
    // - it comes back live when the dialog goes, the same standing the
    // app-update toast has. Gone is gone: the id is claimed, so nothing
    // re-shows it.
    if (shownRef.current && (!available || !signedIn || onboardingBusy)) {
      shownRef.current = false;
      toast.dismiss(LOGIN_IMPORT_ANNOUNCEMENT_TOAST_ID);
      return;
    }
    if (consumed || !available || !signedIn || !onboardingSettled) return;
    if (onboardingBusy || narrated || !settingsReachable) return;
    // A claim, not a consume: `consumed` above is this window's copy, and a
    // second window restored alongside this one holds its own. The claim
    // re-reads the install's record, so of two windows that both get here
    // exactly one shows the toast.
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
    onboardingBusy,
    onboardingSettled,
    settingsReachable,
    signedIn,
  ]);

  return null;
}
