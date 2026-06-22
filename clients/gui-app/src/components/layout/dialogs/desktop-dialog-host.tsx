import { useMemo, type ReactNode } from "react";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useEpicOpenInNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { RestartUpdateDialog } from "@/components/layout/dialogs/restart-update-dialog";
import { AboutDetailsDialog } from "./desktop/about-details-dialog";
import { LogsChooserDialog } from "./desktop/logs-chooser-dialog";
import { OpenEpicInNewWindowDialog } from "./desktop/open-epic-in-new-window-dialog";
import { ReportIssueDialog } from "./desktop/report-issue-dialog";

export function DesktopDialogHost(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );
  const { bridge: appUpdatesBridge, snapshot: appUpdateSnapshot } =
    useDesktopAppUpdates();
  const activeDialog = useDesktopDialogStore((state) => state.activeDialog);
  const close = useDesktopDialogStore((state) => state.close);
  const openEpicInNewWindowFlow = useEpicOpenInNewWindowFlow();

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
      {activeDialog === "report-issue" ? (
        <ReportIssueDialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          support={support}
        />
      ) : null}
      {activeDialog === "confirm-restart-update" &&
      appUpdatesBridge !== null ? (
        <RestartUpdateDialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          latestVersion={appUpdateSnapshot.latestVersion}
          onConfirm={() => {
            void appUpdatesBridge.installUpdate();
          }}
        />
      ) : null}
      <UnsyncedEpicMoveDialog flow={openEpicInNewWindowFlow} />
    </>
  );
}
