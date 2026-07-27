import { useCallback } from "react";
import { toast } from "sonner";
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
    // Mount-time replay: only fire `error` toasts that arrived while the
    // toaster was unmounted (tab swap). `info` / `warning` notices stay
    // mounted-window-only to avoid replaying stale, non-actionable noise.
    handle.store.getState().errorNotices.forEach((notice) => {
      if (!rememberErrorNotice(notice, tracker)) return;
      if (notice.severity !== "error") return;
      showErrorNoticeToast(notice);
    });

    return handle.store.subscribe((state, previousState) => {
      if (state.errorNotices === previousState.errorNotices) return;
      state.errorNotices.forEach((notice) => {
        if (!rememberErrorNotice(notice, tracker)) return;
        showErrorNoticeToast(notice);
      });
    });
  }, [handle]);
  useActivePaneEffect(syncErrorNotices);

  return null;
}

function rememberErrorNotice(
  notice: ChatErrorNotice,
  tracker: DeliveredNoticeTracker,
): boolean {
  if (notice.clientActionId !== null) {
    if (tracker.clientActionIds.has(notice.clientActionId)) return false;
    addWithFifoEviction(
      tracker.clientActionIds,
      notice.clientActionId,
      MAX_DELIVERED_CLIENT_ACTION_IDS,
    );
    return true;
  }
  if (tracker.notices.has(notice)) return false;
  tracker.notices.add(notice);
  return true;
}

function showErrorNoticeToast(notice: ChatErrorNotice): void {
  const message = notice.message.length > 0 ? notice.message : "Action failed.";
  if (notice.severity === "error") {
    reportableErrorToast(message, undefined, CHAT_ACTION_REPORT_CONTEXT);
    return;
  }
  if (notice.severity === "warning") {
    reportableWarningToast(message, undefined, CHAT_ACTION_REPORT_CONTEXT);
    return;
  }
  toast(message);
}
