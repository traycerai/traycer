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

/** The toast shows on the first launch where all of these hold, and showing it claims the `session-import`
 * announcement (`feature-announcements-store`) so it never shows again, in this window or another. */
export function SessionImportAnnouncementController(): ReactNode {
  const available = useSessionImportAvailable();
  // The claim needs a firmer answer than `available`.
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

  // `consumed` cannot stand in for it: the claim flips it the moment the toast shows, and another window's claim
  // flips it with no toast here at all.
  const shownRef = useRef(false);

  useEffect(() => {
    // Not the narrator or a stream drop: both are transient, and a toast under a dialog is inert rather than
    // wrong. Gone is gone: the id is claimed, so nothing re-shows it.
    if (shownRef.current && (!available || !signedIn || tourOpen)) {
      shownRef.current = false;
      toast.dismiss(SESSION_IMPORT_ANNOUNCEMENT_TOAST_ID);
      return;
    }
    if (consumed || !available || !signedIn || !onboardingComplete) return;
    if (tourOpen || narrated || !streamLive || !supported) return;
    // A claim, not a consume: `consumed` above is this window's copy, and a second window restored alongside this
    // one holds its own.
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
      // The toast speaks for the app's active host; the dialog's own picker
      // is where another machine gets chosen.
      initialHostId={null}
    />
  );
}
