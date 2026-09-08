import { countPendingPromptRows } from "@/lib/home-focus/focus-prompts";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";

/**
 * The count on the Home tab: unresolved, unread prompts across every task.
 *
 * Counted through `countPendingPromptRows`, the same selector
 * `buildFocusPrompts` maps its rows from, so this is provably `badgeCount` and
 * not a second derivation that could drift from the "Needs you" section.
 *
 * It deliberately does NOT call `useFocusModel()`, even though that would read
 * better. The badge lives in the tab strip, which is mounted for the life of
 * the window (Home is always present), so a model here would keep the entire
 * cross-task join running whether or not Home is ever opened: subscriptions to
 * the activity store, the chat-session registry, the open-epic registry and
 * every mounted epic's Y.Doc, plus two RPC families keyed on an epic set that
 * moves whenever any task on the account starts or stops. The Home surface
 * itself only mounts once the user opens it (`TopLevelTabHost`), so a model
 * here would be the one thing charging a window that never does. The
 * notification rows this reads are already subscribed by the bell.
 *
 * NOT the bell's count. The bell's attention tier also carries unread failures,
 * which are history rather than a question; this counts only what is waiting on
 * an answer.
 */
export function useHomeBadgeCount(): number {
  return countPendingPromptRows(useMergedNotificationRows());
}
