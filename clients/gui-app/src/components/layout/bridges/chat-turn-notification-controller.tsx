import { use, useEffect } from "react";
import {
  subscribeChatTurnCompletions,
  type ChatTurnCompletion,
} from "@/lib/notifications/chat-turn-completion";
import { liveEpicTitleFromHandle } from "@/lib/epic-selectors";
import { displayTitle } from "@/lib/display-title";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Raises a native OS notification when a chat turn completes while the app
 * window is not focused, gated on the "Notify on chat turn completion" setting.
 *
 * Mounted once at the app root beside `PreventSleepController`. Browser-safe:
 * `runnerHost.notifications.show` is a no-op on shells without a native
 * notification surface, and `document.hasFocus()` is a standard browser API.
 * The click payload (`kind: "chat"`) is routed by `NotificationFocusBridge` to
 * focus the app and open the chat's epic.
 */
export function ChatTurnNotificationController(): null {
  const runnerHost = use(RunnerHostContext);

  useEffect(() => {
    if (runnerHost === null) {
      return;
    }
    return subscribeChatTurnCompletions((completion) => {
      // Read the live setting at fire time so toggling it never tears down and
      // rebuilds the cross-session subscription mid-turn, and never reads a
      // stale value.
      if (!useSettingsStore.getState().notifyOnChatTurnComplete) return;
      if (isAppFocused()) return;
      const { title, body } = buildTurnCompletionNotification(completion);
      void runnerHost.notifications
        .show(title, body, {
          kind: "chat",
          epicId: completion.epicId,
          chatId: completion.chatId,
        })
        .catch(() => {
          // A failed OS toast is non-critical; swallow so it never surfaces as
          // an unhandled rejection.
        });
    });
  }, [runnerHost]);

  return null;
}

function isAppFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

function buildTurnCompletionNotification(completion: ChatTurnCompletion): {
  readonly title: string;
  readonly body: string;
} {
  // Empty title -> "Untitled epic" via `displayTitle`; only a genuinely
  // unresolvable epic (`null`) falls back to the app name.
  const resolvedTitle = resolveEpicTitle(completion.epicId);
  const epicTitle =
    resolvedTitle === null ? "Traycer" : displayTitle(resolvedTitle, "epic");
  const trimmed =
    completion.chatTitle === null ? "" : completion.chatTitle.trim();
  const chatLabel = trimmed.length === 0 ? "New chat" : trimmed;
  return { title: epicTitle, body: `${chatLabel} • Done` };
}

/**
 * Resolve an epic's live title from the open-epic registry (same resolver the
 * header strip uses, so the notification can't drift from the in-app title).
 * Returns `""` for a registered-but-untitled epic, `null` only when no handle
 * exists. `liveEpicTitleFromHandle` collapses empty to `null`, so we restore
 * `""` here to keep "open but untitled" distinct from "not open" (caller maps
 * `""` -> "Untitled epic", `null` -> app name).
 */
function resolveEpicTitle(epicId: string): string | null {
  const handle = getOpenEpicRegistry().peek(epicId);
  if (handle === null) return null;
  return liveEpicTitleFromHandle(handle) ?? "";
}
