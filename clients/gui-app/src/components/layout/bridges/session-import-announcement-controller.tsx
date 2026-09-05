import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ActionToastContent } from "@/components/layout/bridges/action-toast-content";
import {
  gateBlocksApp,
  useHostReadinessController,
  useSurfaceReadiness,
  windowNarratorOwns,
} from "@/components/layout/host-readiness-controller-context";
import { SessionImportDialog } from "@/components/session-import/session-import-dialog";
import { useSessionImportAvailable } from "@/hooks/session-import/use-session-import-available";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import {
  isFeatureAnnouncementConsumed,
  useFeatureAnnouncementsStore,
} from "@/stores/settings/feature-announcements-store";

const SESSION_IMPORT_ANNOUNCEMENT_TOAST_ID =
  "traycer-session-import-announcement";

/**
 * Tells a user who already finished onboarding that this release can import
 * the work they started in other coding agents - once, ever, per install.
 *
 * The same shape as `LoginImportAnnouncementController`, with two
 * differences. The action opens the import wizard RIGHT HERE, as a dialog
 * under the app-wide stream binding (the active host, the one the home
 * screen's terminal lands on), rather than navigating to Settings through a
 * one-shot intent - the wizard is self-contained and needs no row to land
 * on. And the tour never consumes the id on its own finish: only mounting
 * the wizard does (`SessionImportWizard`), so a user who skipped the tour
 * before its import act still gets this toast, which is the point of it.
 *
 * The toast shows on the first launch where ALL of these hold, and showing
 * it claims the `session-import` announcement (`feature-announcements-store`)
 * so it never shows again, in this window or another:
 *
 * - the bound host can import sessions (`useSessionImportAvailable`; a host
 *   that predates the feature hides the row, so a toast leading to nothing
 *   would be worse than none);
 * - the user is signed in and has COMPLETED onboarding - a fresh user meets
 *   the feature as the tour's last act instead, which consumes the same id;
 * - the tour is not on screen (a replay from Settings), for the reason the
 *   session-import progress toast holds: a toast over the stage is noise;
 * - the window narrator does not own the frame with the app gated behind
 *   its dialog, where a toast renders dead (`pointer-events: none`) and
 *   could never be dismissed - the same predicate the app-update toast
 *   reads. Held, not dropped: the effect re-runs when the narrator releases;
 * - the app-wide stream client is live, so the dialog the action opens has a
 *   host to scan. Held, never a reason to dismiss: a reconnect is transient,
 *   and the claim is permanent.
 *
 * "Later" just dismisses - the announcement is consumed either way. A gate
 * that closes while the toast is up - the host losing the capability,
 * sign-out, the tour opening - dismisses it, since it is permanent
 * otherwise; see the effect.
 */
export function SessionImportAnnouncementController(): ReactNode {
  const available = useSessionImportAvailable();
  // The CLAIM needs a firmer answer than `available`. That predicate treats
  // the pre-handshake "unknown" as available on purpose, so a Settings row
  // does not blink away during a reconnect - but a claim is permanent, and
  // one made against an older host during that window shows a toast the
  // next render dismisses while the install's record stays "announced".
  // Nothing then ever announces the feature, however capable a later host
  // is. So the toast is held until negotiation has said "supported".
  const supported =
    useStreamMethodSupport("sessionImport.scan") === "supported";
  const streamLive = useWsStreamClient() !== null;
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const onboardingComplete = useOnboardingStore(
    (state) => state.completedAt !== null,
  );
  const tourOpen = useOnboardingTourOpenStore((state) => state.open);
  const consumed = useFeatureAnnouncementsStore((state) =>
    isFeatureAnnouncementConsumed(state.consumed, "session-import"),
  );
  const claim = useFeatureAnnouncementsStore((state) => state.claim);
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
  const [dialogOpen, setDialogOpen] = useState(false);

  // Whether THIS controller put the toast up. `consumed` cannot stand in
  // for it: the claim flips it the moment the toast shows, and another
  // window's claim flips it with no toast here at all.
  const shownRef = useRef(false);

  useEffect(() => {
    // The toast is permanent, so a gate that closes after it is up takes it
    // down: the host losing the capability (a swap to an older host), a
    // sign-out, or the tour opening (a replay from Settings, which shows the
    // same feature as an act, and a toast over the stage is noise). Not the
    // narrator or a stream drop: both are transient, and a toast under a
    // dialog is inert rather than wrong. Gone is gone: the id is claimed, so
    // nothing re-shows it.
    if (shownRef.current && (!available || !signedIn || tourOpen)) {
      shownRef.current = false;
      toast.dismiss(SESSION_IMPORT_ANNOUNCEMENT_TOAST_ID);
      return;
    }
    if (consumed || !available || !signedIn || !onboardingComplete) return;
    if (tourOpen || narrated || !streamLive || !supported) return;
    // A claim, not a consume: `consumed` above is this window's copy, and a
    // second window restored alongside this one holds its own. The claim
    // re-reads the install's record, so of two windows that both get here
    // exactly one shows the toast.
    if (!claim("session-import")) return;
    shownRef.current = true;
    toast(
      <ActionToastContent
        toastId={SESSION_IMPORT_ANNOUNCEMENT_TOAST_ID}
        eyebrow="New in this release"
        title="Bring your work with you"
        description="Import work you started in other coding agents and keep going within Traycer."
        actionLabel="Import work…"
        onAction={() => {
          setDialogOpen(true);
        }}
        onLater={null}
      />,
      {
        id: SESSION_IMPORT_ANNOUNCEMENT_TOAST_ID,
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
    signedIn,
    streamLive,
    tourOpen,
    supported,
  ]);

  if (!dialogOpen) return null;
  return (
    <SessionImportDialog
      onClose={() => {
        setDialogOpen(false);
      }}
    />
  );
}
