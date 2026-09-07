import { useCallback, type ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import type { ChatErrorNotice } from "@traycer/protocol/host/agent/gui/subscribe";
import { addWithFifoEviction } from "@/lib/bounded-set";
import { useActivePaneEffect } from "@/components/epic-tabs/pane-visibility-context";
import {
  MAX_DELIVERED_CLIENT_ACTION_IDS,
  type ChatSessionStoreHandle,
  type DeliveredNoticeTracker,
} from "@/stores/chats/chat-session-store";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  forgetRetainedDraftToast,
  rememberRetainedDraftToast,
} from "@/lib/toast/retained-draft-toasts";
import {
  noticeCarriesOnlyCopy,
  noticeMustSurviveUnfocus,
} from "@/stores/chats/chat-queue-reconciler";
import {
  createRetainingReportAction,
  reportableErrorToast,
  reportableWarningToast,
} from "@/lib/reportable-error-toast";

const CHAT_ACTION_REPORT_CONTEXT = createReportIssueContext({
  title: "Agent action failed",
  message: null,
  code: null,
  source: "Chat",
});

interface ChatTileErrorNoticeToastsProps {
  readonly handle: ChatSessionStoreHandle;
}

export function ChatTileErrorNoticeToasts(
  props: ChatTileErrorNoticeToastsProps,
) {
  const { handle } = props;
  const syncErrorNotices = useCallback(() => {
    const tracker = handle.deliveredNotices;
    // Mount-time replay: `error` toasts that arrived while the toaster was unmounted (tab swap), plus any notice CARRYING the only copy of the user's text.
    // `info` / `warning` otherwise stay mounted-window-only to avoid replaying stale, non-actionable noise.
    handle.store.getState().errorNotices.forEach((notice) => {
      // Deciding first looks like it fixes the id-poisoning below, and it does - by breaking something else: the subscription pass re-walks the WHOLE ring on every append with no severity gate, and it is safe only because everything this pass declined to show is already muted.
      // Skipping without remembering turns every stale warning into a time bomb that the next unrelated append resurrects, all of them at once.
      if (!rememberErrorNotice(notice, tracker)) return;
      if (notice.severity !== "error" && !noticeMustSurviveUnfocus(notice)) {
        return;
      }
      showErrorNoticeToast(notice);
      markDelivered(handle, notice);
    });

    return handle.store.subscribe((state, previousState) => {
      if (state.errorNotices === previousState.errorNotices) return;
      state.errorNotices.forEach((notice) => {
        if (!rememberErrorNotice(notice, tracker)) return;
        showErrorNoticeToast(notice);
        markDelivered(handle, notice);
      });
    });
  }, [handle]);
  useActivePaneEffect(syncErrorNotices);

  return null;
}

/**
 * Only `SEND_RESTORED` is held for delivery, but recording every id keeps the rule in one place rather than teaching this layer which codes are special.
 */
function markDelivered(
  handle: ChatSessionStoreHandle,
  notice: ChatErrorNotice,
): void {
  if (notice.clientActionId === null) return;
  handle.store.getState().markNoticeDelivered(notice.clientActionId);
}

function rememberErrorNotice(
  notice: ChatErrorNotice,
  tracker: DeliveredNoticeTracker,
): boolean {
  if (notice.clientActionId !== null) {
    // A last-copy record is never evicted from the ring, so its delivery state cannot be either: the FIFO tracker below would forget it after 128 ordinary notices, and the next arrival re-traverses the ring and fires the draft toast a second time.
    if (noticeCarriesOnlyCopy(notice)) {
      if (tracker.retainedClientActionIds.has(notice.clientActionId)) {
        return false;
      }
      tracker.retainedClientActionIds.add(notice.clientActionId);
      return true;
    }
    // A bare-id key made the second one a duplicate of a notice that was muted rather than shown, so the telling that was supposed to reach the user was the one dropped.
    const key = deliveryKey(notice);
    if (tracker.clientActionIds.has(key)) return false;
    addWithFifoEviction(
      tracker.clientActionIds,
      key,
      MAX_DELIVERED_CLIENT_ACTION_IDS,
    );
    return true;
  }
  if (tracker.notices.has(notice)) return false;
  tracker.notices.add(notice);
  return true;
}

/**
 * The component tracker's key.
 * Deliberately NOT the store's key: the store's `deliveredNoticeActionIds` answers "did any speaker for this action reach the user", which is a question about the ACTION, so a bare id is right there.
 */
function deliveryKey(notice: ChatErrorNotice): string {
  return `${notice.code}:${notice.clientActionId ?? ""}`;
}

function showErrorNoticeToast(notice: ChatErrorNotice): void {
  const text = notice.message.length > 0 ? notice.message : "Action failed.";
  // A last-copy notice's newlines and indentation ARE the guarantee - the store went to some trouble to keep the bytes verbatim, and default HTML whitespace collapsing undoes all of it on screen and on copy.
  // Rendering it pre-wrap is what makes the byte promise reach the user.
  const message: ReactNode = noticeCarriesOnlyCopy(notice) ? (
    <span className="whitespace-pre-wrap break-words">{text}</span>
  ) : (
    text
  );
  // Letting that expire on the default timer would put the only remaining copy of someone's text on a few-second fuse - so it stays until dismissed.
  // A toast with no lifetime needs an owner: the app-level `<Toaster />` sits outside the auth-dependent tree, so without one this outlives sign-out and shows the previous account's draft to the next person on the machine.
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
