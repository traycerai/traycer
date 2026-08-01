import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "sonner";
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
  const lastConfirmedReport = useDesktopDialogStore(
    (state) => state.lastConfirmedReport,
  );
  const setLastConfirmedReport = useDesktopDialogStore(
    (state) => state.setLastConfirmedReport,
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

  // G2: a new report trigger while a confirmation is showing replaces the
  // dialog outright (the host below always remounts by `reportIssueDraftId`)
  // - but the confirmation holds the only copy of that report id, so surface
  // it in a toast before it is gone for good. `lastConfirmedReport` is
  // cleared on any intentional close, so this only fires for a live
  // replacement, never after the user already dismissed the confirmation.
  const previousDraftIdRef = useRef(reportIssueDraftId);
  useEffect(() => {
    const previousDraftId = previousDraftIdRef.current;
    previousDraftIdRef.current = reportIssueDraftId;
    if (previousDraftId === reportIssueDraftId) return;
    if (
      lastConfirmedReport === null ||
      lastConfirmedReport.draftId !== previousDraftId
    ) {
      return;
    }
    toast.info("Your previous report is safe", {
      description: `Report ID ${lastConfirmedReport.reportId}`,
    });
    setLastConfirmedReport(null);
  }, [reportIssueDraftId, lastConfirmedReport, setLastConfirmedReport]);

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
