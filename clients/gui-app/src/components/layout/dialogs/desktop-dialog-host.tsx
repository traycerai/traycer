import { useEffect, useMemo, type ReactNode } from "react";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useEpicOpenInNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { InstallGuidanceDialog } from "@/components/layout/dialogs/install-guidance-dialog";
import { AboutDetailsDialog } from "./desktop/about-details-dialog";
import { LogsChooserDialog } from "./desktop/logs-chooser-dialog";
import { OpenEpicInNewWindowDialog } from "./desktop/open-epic-in-new-window-dialog";

export function DesktopDialogHost(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );
  const { snapshot: appUpdateSnapshot } = useDesktopAppUpdates();
  const activeDialog = useDesktopDialogStore((state) => state.activeDialog);
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
      <UnsyncedEpicMoveDialog flow={openEpicInNewWindowFlow} />
    </>
  );
}
