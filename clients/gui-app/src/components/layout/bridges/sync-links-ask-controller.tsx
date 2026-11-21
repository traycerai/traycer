import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SyncLinksFolder } from "@traycer/protocol/host/sync-links-schemas";
import { ActionToastContent } from "@/components/layout/bridges/action-toast-content";
import {
  gateBlocksApp,
  useHostReadinessController,
  useSurfaceReadiness,
  windowNarratorOwns,
} from "@/components/layout/host-readiness-controller-context";
import { useThisComputer } from "@/components/settings/move/this-computer";
import { useMoveAskHoldsAnnouncements } from "@/components/settings/move/use-move-ask-holds-announcements";
import { SyncLinksAskDialog } from "@/components/sync-links/sync-links-ask-dialog";
import { namedPeers } from "@/components/sync-links/sync-links-peers";
import {
  ASK_TOAST_ACTION,
  askToastTitle,
} from "@/components/sync-links/sync-links-copy";
import { useProvidersSyncLinksListQuery } from "@/hooks/providers/use-providers-sync-links-list-query";
import { useProvidersSyncLinksStopMutation } from "@/hooks/providers/use-providers-sync-links-stop-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const SYNC_LINKS_ASK_TOAST_ID = "traycer-sync-links-ask";

const NO_FOLDERS: readonly SyncLinksFolder[] = [];

/**
 * The window narrator owns the frame with the app gated behind its dialog,
 * where a toast renders dead: the predicate import's toast holds on.
 */
function useNarratorOwnsFrame(signedIn: boolean): boolean {
  const readiness = useSurfaceReadiness("default-host", null);
  const { hasBeenDefaultHostReady } = useHostReadinessController();
  return (
    windowNarratorOwns(readiness) &&
    !gateBlocksApp({
      readiness,
      hasBeenReady: hasBeenDefaultHostReady,
      signedIn,
      bypassed: false,
    })
  );
}

/**
 * Import's gates, read the same way. `ready`: a signed-in person past
 * onboarding. `staged`: the tour or the first-task guide is on screen, which
 * takes the ask down. `held`: the toast waits but the ask stands - the
 * narrator owns the frame (a toast there renders dead), or this computer's
 * own move ask is owed or its sheet is open: one ask about Personal at a time.
 */
function useAskGates(): {
  readonly ready: boolean;
  readonly staged: boolean;
  readonly held: boolean;
} {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const onboardingComplete = useOnboardingStore(
    (state) => state.completedAt !== null,
  );
  const tourOpen = useOnboardingTourOpenStore((state) => state.open);
  const guideActive = useFirstTaskGuideStore(
    (state) => state.status === "active",
  );
  const narrated = useNarratorOwnsFrame(signedIn);
  const ready = signedIn && onboardingComplete;
  const moveAskHolds = useMoveAskHoldsAnnouncements(ready);
  return {
    ready,
    staged: tourOpen || guideActive,
    held: narrated || moveAskHolds,
  };
}

/**
 * Asks, on a computer a 1.5.4 "Sync profiles" linked to others, whether to
 * move the linked accounts into Personal or stop syncing them (design D5,
 * canvas sync-links-ask). The toast is shown the way the session-import
 * announcement shows its own: permanent, one action, under one id.
 *
 * It reads THIS computer's list (`providers.syncLinks.list`), only from a host
 * that negotiated it, so a 1.5.4 host never asks. The ask stands while any
 * folder is still unanswered (`hold: "none"`): an ignored ask stays as the
 * toast (I8), and every linked computer asks once it is updated (I3). A
 * folder held for Personal has been answered with Move and leaves the ask.
 *
 * The toast waits on import's gates: a signed-in person past onboarding, no
 * tour or first-task guide on screen, no narrator owning the frame, and this
 * computer's move ask neither owed nor open (`useMoveAskHoldsAnnouncements`,
 * which also holds while the Move sheet is open). It steps aside while its
 * own modal is open, and comes back when either closes with a folder still
 * unanswered.
 */
export function SyncLinksAskController(): ReactNode {
  const computer = useThisComputer();
  const gates = useAskGates();
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);

  const list = useProvidersSyncLinksListQuery(computer.client, gates.ready);
  const stop = useProvidersSyncLinksStopMutation(computer.client);
  const listed = list.data?.folders ?? NO_FOLDERS;
  const folders = listed.filter((folder) => folder.hold === "none");
  const teamComputer = list.data?.teamComputer ?? false;
  const [dialogOpen, setDialogOpen] = useState(false);

  const asking = folders.length > 0 && gates.ready && !gates.staged;
  const toastShown = asking && !gates.held && !dialogOpen;
  const title = askToastTitle(namedPeers(folders).map((peer) => peer.name));

  // Whether THIS controller put the toast up, so a closed gate takes down
  // only a toast it showed.
  const shownRef = useRef(false);

  useEffect(() => {
    if (!toastShown) {
      if (shownRef.current) {
        shownRef.current = false;
        toast.dismiss(SYNC_LINKS_ASK_TOAST_ID);
      }
      return;
    }
    shownRef.current = true;
    toast(
      <ActionToastContent
        toastId={SYNC_LINKS_ASK_TOAST_ID}
        eyebrow={null}
        title={title}
        description={null}
        actionLabel={ASK_TOAST_ACTION}
        onAction={() => {
          setDialogOpen(true);
        }}
        onLater={null}
        showLater={false}
      />,
      {
        id: SYNC_LINKS_ASK_TOAST_ID,
        description: null,
        duration: Infinity,
        cancel: null,
      },
    );
  }, [title, toastShown]);

  useEffect(
    () => () => {
      if (shownRef.current) toast.dismiss(SYNC_LINKS_ASK_TOAST_ID);
    },
    [],
  );

  if (!dialogOpen || !asking) return null;
  return (
    <SyncLinksAskDialog
      folders={folders}
      teamComputer={teamComputer}
      stopPending={stop.isPending}
      stopIssue={
        stop.isError ? { kind: "refused", line: stop.error.message } : null
      }
      onStop={() => {
        stop.mutate(
          { scope: { kind: "all" } },
          {
            onSuccess: () => {
              setDialogOpen(false);
            },
          },
        );
      }}
      onMove={() => {
        if (computer.hostId === null) return;
        setDialogOpen(false);
        openMoveSheet({ hostId: computer.hostId, hostName: computer.hostName });
      }}
      onClose={() => {
        setDialogOpen(false);
        // A failed Stop belongs to the opening it failed in.
        stop.reset();
      }}
    />
  );
}
