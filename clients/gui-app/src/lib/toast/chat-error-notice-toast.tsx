import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  createRetainingReportAction,
  reportableErrorToast,
  reportableWarningToast,
} from "@/lib/reportable-error-toast";
import {
  forgetRetainedDraftToast,
  rememberRetainedDraftToast,
} from "@/lib/toast/retained-draft-toasts";
import { noticeCarriesOnlyCopy } from "@/stores/chats/chat-queue-reconciler";
import { TOO_MANY_ATTACHMENTS_CODE } from "@traycer/protocol/common/file-attachment";

export const CHAT_ACTION_REPORT_CONTEXT = createReportIssueContext({
  title: "Agent action failed",
  message: null,
  code: null,
  source: "Chat",
});

export function showErrorNoticeToast(notice: ChatErrorNotice): void {
  const text = notice.message.length > 0 ? notice.message : "Action failed.";
  // A last-copy notice's newlines and indentation ARE the guarantee - the
  // store went to some trouble to keep the bytes verbatim, and default HTML
  // whitespace collapsing undoes all of it on screen and on copy. Rendering
  // it pre-wrap is what makes the byte promise reach the user. Ordinary
  // notices stay plain strings; nothing about them needs preserving.
  const message: ReactNode = noticeCarriesOnlyCopy(notice) ? (
    <span className="whitespace-pre-wrap break-words">{text}</span>
  ) : (
    text
  );
  // A `SEND_NOT_RECORDED` notice INLINES the user's message body because the
  // client was its last holder (see `unrecoverableSendNotice`). Letting that
  // expire on the default timer would put the only remaining copy of someone's
  // text on a few-second fuse - so it stays until dismissed. The `Toaster`
  // renders a close button by default, so this can always be dismissed.
  //
  // Its report affordance moves to the ACTION slot, and the CANCEL slot is
  // explicitly emptied. Sonner dismisses unconditionally on a cancel click, so
  // the auto-added "Report issue" cancel destroyed the very text it was
  // reporting about: the report draft does not carry the notice body, and
  // `rememberErrorNotice` has already retained this id so nothing replays it.
  // See `createRetainingReportAction`.
  //
  // A toast with no lifetime needs an owner: the app-level `<Toaster />` sits
  // outside the auth-dependent tree, so without one this outlives sign-out and
  // shows the previous account's draft to the next person on the machine. The
  // id is registered so the identity boundary can take it down, and dropped
  // again when the toast goes on its own.
  // A send or a queued message over the per-message file cap. The person's
  // message is over a limit, not something broken, so it is said plainly and
  // offers no report; the host's text says how many and what to do.
  if (notice.code === TOO_MANY_ATTACHMENTS_CODE) {
    toast.warning("Too many files attached", { description: text });
    return;
  }
  const retained = noticeCarriesOnlyCopy(notice);
  const options: ExternalToast | undefined = retained
    ? {
        duration: Number.POSITIVE_INFINITY,
        cancel: null,
        action: createRetainingReportAction(CHAT_ACTION_REPORT_CONTEXT),
        onDismiss: (shown) => forgetRetainedDraftToast(shown.id),
        onAutoClose: (shown) => forgetRetainedDraftToast(shown.id),
      }
    : undefined;
  const shownId = showToastForSeverity(notice.severity, message, options);
  if (retained) rememberRetainedDraftToast(shownId);
}

function showToastForSeverity(
  severity: ChatErrorNotice["severity"],
  message: ReactNode,
  options: ExternalToast | undefined,
): string | number {
  if (severity === "error") {
    return reportableErrorToast(message, options, CHAT_ACTION_REPORT_CONTEXT);
  }
  if (severity === "warning") {
    return reportableWarningToast(message, options, CHAT_ACTION_REPORT_CONTEXT);
  }
  return toast(message, options);
}
