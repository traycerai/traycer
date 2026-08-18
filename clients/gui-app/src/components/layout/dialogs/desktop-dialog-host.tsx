import { useEffect, useMemo, type ReactNode } from "react";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useEpicOpenInNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { InstallGuidanceDialog } from "@/components/layout/dialogs/install-guidance-dialog";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { AboutDetailsDialog } from "./desktop/about-details-dialog";
import { LogsChooserDialog } from "./desktop/logs-chooser-dialog";
import { OpenEpicInNewWindowDialog } from "./desktop/open-epic-in-new-window-dialog";

export function DesktopDialogHost(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );
  const appUpdates = useDesktopAppUpdates();
  const appUpdateSnapshot = appUpdates.snapshot;
  const activeDialog = useDesktopDialogStore((state) => state.activeDialog);
  const updateUnsyncedEpics = useDesktopDialogStore(
    (state) => state.updateUnsyncedEpics,
  );
  const close = useDesktopDialogStore((state) => state.close);
  const openEpicInNewWindowFlow = useEpicOpenInNewWindowFlow();

  // If guidance disappears while the dialog is open (defensive - there's no
  // normal flow that clears it mid-display), don't leave a stale dialog with no
  // content behind it.
  useEffect(() => {
    if (
      activeDialog === "install-guidance" &&
      appUpdateSnapshot.installGuidance === null
    ) {
      close();
    }
  }, [activeDialog, appUpdateSnapshot.installGuidance, close]);

  return (
    <>
      <AboutDetailsDialog
        open={activeDialog === "about-details"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        support={support}
        openExternalLink={(url) => runnerHost.openExternalLink(url)}
      />
      <LogsChooserDialog
        open={activeDialog === "logs"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        support={support}
      />
      {activeDialog === "open-epic-in-new-window" ? (
        <OpenEpicInNewWindowDialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          close={close}
          flow={openEpicInNewWindowFlow}
        />
      ) : null}
      {activeDialog === "install-guidance" &&
      appUpdateSnapshot.installGuidance !== null ? (
        <InstallGuidanceDialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          guidance={appUpdateSnapshot.installGuidance}
        />
      ) : null}
      {/*
        Routed through `ConfirmDestructiveDialog` rather than a hand-rolled
        footer: the primitive orders Cancel first and is safe by construction,
        which is what the three hand-rolled unsynced footers had to be fixed to
        do one at a time. This dialog gates the same class of loss, so it takes
        the primitive instead of repeating them.

        `appUpdates.bridge` is resolved here rather than carried through the
        store, so the confirm path calls the same bridge every other update
        action uses and no callback has to be parked in state to go stale.
      */}
      {activeDialog === "update-unsynced-confirm" &&
      appUpdates.bridge !== null ? (
        <ConfirmDestructiveDialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          title="Install update and discard unsaved work?"
          description={describeUnsyncableWork(updateUnsyncedEpics)}
          cascadeSummary={null}
          actionLabel="Install and discard"
          isPending={false}
          onConfirm={() => {
            const bridge = appUpdates.bridge;
            if (bridge === null) return;
            close();
            void bridge.installUpdate();
          }}
        />
      ) : null}
      <UnsyncedEpicMoveDialog flow={openEpicInNewWindowFlow} />
    </>
  );
}

/**
 * Names the epics whose work the restart would destroy.
 *
 * Deliberately says "cannot be saved" rather than "unsynced": the whole point
 * of this prompt is that waiting will not help. These buffers were detached
 * from their transport by a host re-point and no epic document has local
 * persistence, so there is no state in which they later sync on their own -
 * telling the user to wait would be the one piece of advice that cannot work.
 */
function describeUnsyncableWork(
  epics: ReadonlyArray<{ readonly title: string }>,
): string {
  const titles = epics.map((epic) => epic.title).join(", ");
  const subject =
    epics.length === 1
      ? "1 Epic has changes"
      : `${epics.length} Epics have changes`;
  return `${subject} that cannot be saved - they were kept when their host changed and have nowhere left to sync to. Installing restarts Traycer and discards them: ${titles}.`;
}
