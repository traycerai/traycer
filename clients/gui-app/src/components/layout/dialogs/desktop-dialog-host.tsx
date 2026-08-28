import { useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useEpicOpenInNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { InstallGuidanceDialog } from "@/components/layout/dialogs/install-guidance-dialog";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { confirmAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
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
  const updateUnsyncedOtherWindowsUnknown = useDesktopDialogStore(
    (state) => state.updateUnsyncedOtherWindowsUnknown,
  );
  const close = useDesktopDialogStore((state) => state.close);
  const openEpicInNewWindowFlow = useEpicOpenInNewWindowFlow();
  // Confirm re-runs the app-wide unsyncable check before installing (see
  // `confirmAppUpdateInstall`); while it is in flight the dialog is pending so
  // a second click cannot race two checks - and two installs - out of one
  // consent.
  const [updateInstallConfirmPending, setUpdateInstallConfirmPending] =
    useState(false);

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

        Confirm does not install off the captured rows: it hands them to
        `confirmAppUpdateInstall`, which re-checks every window and installs
        only if nothing NEW would be lost - otherwise the rows below are
        replaced with the fresh full set and the user confirms again.
      */}
      {activeDialog === "update-unsynced-confirm" &&
      appUpdates.bridge !== null ? (
        <ConfirmDestructiveDialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          title={
            updateUnsyncedOtherWindowsUnknown &&
            updateUnsyncedEpics.length === 0
              ? "Install update without checking other windows?"
              : "Install update and discard unsaved work?"
          }
          description={describeUnsyncableWork(
            updateUnsyncedEpics,
            updateUnsyncedOtherWindowsUnknown,
          )}
          cascadeSummary={null}
          actionLabel="Install and discard"
          isPending={updateInstallConfirmPending}
          onConfirm={() => {
            const bridge = appUpdates.bridge;
            if (bridge === null || updateInstallConfirmPending) return;
            setUpdateInstallConfirmPending(true);
            // The door closes the dialog itself on install, or replaces the
            // rows with the fresh full set and leaves it open when the
            // protected set changed under the user - so `close()` is not
            // called here: on "reconfirm" the dialog must stay up.
            void confirmAppUpdateInstall(bridge, {
              epics: updateUnsyncedEpics,
              otherWindowsUnknown: updateUnsyncedOtherWindowsUnknown,
            }).finally(() => {
              setUpdateInstallConfirmPending(false);
            });
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
 *
 * `otherWindowsUnknown` is the fail-closed arm: the app-wide check did not
 * answer, so whatever is named here is only THIS window's share, and the copy
 * has to say that other windows may hold more - or, when nothing local is
 * named, that the install is proceeding without the check at all.
 */
function describeUnsyncableWork(
  epics: ReadonlyArray<{ readonly title: string }>,
  otherWindowsUnknown: boolean,
): string {
  const unknownSuffix = otherWindowsUnknown
    ? " Traycer could not check the other windows, which may hold more."
    : "";
  if (otherWindowsUnknown && epics.length === 0) {
    return "Traycer could not check the other windows for changes that cannot be saved (changes kept when a host changed have nowhere left to sync to). Installing restarts Traycer and discards any such work in another window.";
  }
  const titles = epics.map((epic) => epic.title).join(", ");
  const subject =
    epics.length === 1
      ? "1 Epic has changes"
      : `${epics.length} Epics have changes`;
  return `${subject} that cannot be saved - they were kept when their host changed and have nowhere left to sync to. Installing restarts Traycer and discards them: ${titles}.${unknownSuffix}`;
}
