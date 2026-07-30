import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import {
  isReportIssueDraftContext,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/**
 * Widened rather than given a new parameter (guardrail G9): the ~50+
 * existing callers all pass a plain {@link ReportIssueContext} and are
 * untouched. A caller with a structured private cause to attach can pass a
 * {@link ReportIssueDraftContext} instead - `showReportableToast` branches
 * on which one it got.
 */
type ReportableToastContext = ReportIssueContext | ReportIssueDraftContext;

export function reportableErrorToast(
  message: ReactNode,
  options: ExternalToast | undefined,
  privacySafeContext: ReportableToastContext,
): string | number {
  return showReportableToast(message, options, privacySafeContext, toast.error);
}

export function reportableWarningToast(
  message: ReactNode,
  options: ExternalToast | undefined,
  privacySafeContext: ReportableToastContext,
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
  privacySafeContext: ReportableToastContext,
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
  context: ReportableToastContext,
): NonNullable<ExternalToast["cancel"]> {
  return {
    label: "Report issue",
    onClick: () => {
      const current = useDesktopDialogStore.getState();
      if (!current.reportIssueAvailable) return;
      Analytics.getInstance().track(AnalyticsEvent.ReportIssueOpened, {
        source: "notification",
      });
      if (isReportIssueDraftContext(context)) {
        current.openReportIssueDraft(context);
      } else {
        current.openReportIssueWithContext(context);
      }
    },
  };
}
