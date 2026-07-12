import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

export function reportableErrorToast(
  message: ReactNode,
  options: ExternalToast | undefined,
  privacySafeContext: ReportIssueContext,
): string | number {
  return showReportableToast(message, options, privacySafeContext, toast.error);
}

export function reportableWarningToast(
  message: ReactNode,
  options: ExternalToast | undefined,
  privacySafeContext: ReportIssueContext,
): string | number {
  return showReportableToast(
    message,
    options,
    privacySafeContext,
    toast.warning,
  );
}

function showReportableToast(
  message: ReactNode,
  options: ExternalToast | undefined,
  privacySafeContext: ReportIssueContext,
  showToast: typeof toast.error,
): string | number {
  const state = useDesktopDialogStore.getState();
  if (!state.reportIssueAvailable) {
    if (options === undefined) return showToast(message);
    if (options.id === undefined) return showToast(message, options);
    return showToast(
      message,
      options.cancel === undefined ? { ...options, cancel: null } : options,
    );
  }
  const cancel =
    options !== undefined && "cancel" in options
      ? options.cancel
      : createReportAction(privacySafeContext);
  return showToast(message, {
    ...options,
    cancel,
  });
}

function createReportAction(
  context: ReportIssueContext,
): NonNullable<ExternalToast["cancel"]> {
  return {
    label: "Report issue",
    onClick: () => {
      const current = useDesktopDialogStore.getState();
      if (!current.reportIssueAvailable) return;
      current.openReportIssueWithContext(context);
    },
  };
}
