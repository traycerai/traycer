import { useEffect, useMemo, type ReactNode } from "react";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { ReportIssueDialog } from "./desktop/report-issue-dialog";

export function ReportIssueDialogHost(): ReactNode {
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );
  const activeDialog = useDesktopDialogStore((state) => state.activeDialog);
  const reportIssueDraftId = useDesktopDialogStore(
    (state) => state.reportIssueDraftId,
  );
  const close = useDesktopDialogStore((state) => state.close);
  const setReportIssueAvailable = useDesktopDialogStore(
    (state) => state.setReportIssueAvailable,
  );

  useEffect(() => {
    setReportIssueAvailable(support !== null);
    if (support === null && activeDialog === "report-issue") {
      close();
    }
    return () => {
      setReportIssueAvailable(false);
    };
  }, [activeDialog, close, setReportIssueAvailable, support]);

  if (activeDialog !== "report-issue" || support === null) return null;
  return (
    <ReportIssueDialog
      key={reportIssueDraftId}
      draftId={reportIssueDraftId}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      support={support}
    />
  );
}
