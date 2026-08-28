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
    onClick: () => openReportIssue(context),
  };
}

/**
 * The "Report issue" affordance as a NON-DISMISSING action button.
 *
 * Sonner's two button slots differ, and the difference is load-bearing here:
 * the CANCEL slot calls `deleteToast()` unconditionally once its `onClick`
 * returns - `preventDefault` is never consulted on that path - while the
 * ACTION slot checks `event.defaultPrevented` first. So a toast that must
 * SURVIVE being reported cannot carry its report affordance as a cancel.
 *
 * That matters for a toast whose body is the last copy of the user's text: the
 * report draft does not carry the notice body (it must not - a report context
 * is public, and it collapses whitespace and truncates), and the delivered-
 * notice tracker has already retained the id so nothing replays it. Dismissing
 * on report therefore destroyed the only copy of the draft it was reporting
 * about.
 *
 * `undefined` when reporting is unavailable, matching the cancel-side gate in
 * {@link showReportableToast}: the button is absent there, not merely inert.
 */
export function createRetainingReportAction(
  context: ReportableToastContext,
): ExternalToast["action"] {
  if (!useDesktopDialogStore.getState().reportIssueAvailable) return undefined;
  return {
    label: "Report issue",
    onClick: (event) => {
      // Before the handler, so an early return inside it cannot leave the
      // dismissal armed.
      event.preventDefault();
      openReportIssue(context);
    },
  };
}

function openReportIssue(context: ReportableToastContext): void {
  const current = useDesktopDialogStore.getState();
  if (!current.reportIssueAvailable) return;
  Analytics.getInstance().track(AnalyticsEvent.ReportIssueOpened, {
    source: "notification",
    surface: isReportIssueDraftContext(context)
      ? context.publicPrefill.source
      : context.source,
  });
  if (isReportIssueDraftContext(context)) {
    current.openReportIssueDraft(context);
  } else {
    current.openReportIssueWithContext(context);
  }
}
