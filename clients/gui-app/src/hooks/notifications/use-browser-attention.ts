import { useEffect, useRef } from "react";
import {
  useMergedNotificationRows,
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";

export interface BrowserAttentionTarget {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string | null;
  readonly tabId: string | null;
}

export function browserAttentionMatches(
  row: MergedNotificationRow,
  target: BrowserAttentionTarget,
): boolean {
  return (
    row.hostKind === "browser.human.needed" &&
    row.readAt === null &&
    row.resolvedAt === null &&
    row.originHostId === target.hostId &&
    row.payload?.kind === "browserSession" &&
    row.payload.epicId === target.epicId &&
    row.payload.sessionId === target.sessionId &&
    row.payload.tabId === target.tabId
  );
}

export function useBrowserAttention(target: BrowserAttentionTarget): boolean {
  return useMergedNotificationRows().some((row) =>
    browserAttentionMatches(row, target),
  );
}

/** Read the notice when its browser becomes the foreground surface. This
 * acknowledges attention only; it never resumes the parked automation. */
export function useConsumeBrowserAttention(
  target: BrowserAttentionTarget,
  active: boolean,
): void {
  const rows = useMergedNotificationRows();
  const { markAsRead } = useMergedNotificationsActions();
  const { epicId, hostId, sessionId, tabId } = target;
  const consumed = useRef(new Set<string>());
  const foreground = useRef(false);
  useEffect(() => {
    if (!active) {
      consumed.current.clear();
      foreground.current = false;
      return;
    }
    const consume = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus())
        return;
      for (const row of rows) {
        if (
          browserAttentionMatches(row, { epicId, hostId, sessionId, tabId })
        ) {
          const occurrence = `${row.feedId}:${row.createdAt}`;
          if (consumed.current.has(occurrence)) continue;
          consumed.current.add(occurrence);
          markAsRead(row);
        }
      }
    };
    const consumeOnForeground = () => {
      const nextForeground =
        document.visibilityState === "visible" && document.hasFocus();
      // Retry unread rows on a new foreground transition after a failed read.
      // Focus and visibility events can describe the same transition, so only
      // the first one clears attempted reads; ordinary rerenders also dedupe.
      if (nextForeground && !foreground.current) consumed.current.clear();
      foreground.current = nextForeground;
      consume();
    };
    const leaveForeground = () => {
      foreground.current = false;
    };
    consumeOnForeground();
    window.addEventListener("focus", consumeOnForeground);
    window.addEventListener("blur", leaveForeground);
    document.addEventListener("visibilitychange", consumeOnForeground);
    return () => {
      window.removeEventListener("focus", consumeOnForeground);
      window.removeEventListener("blur", leaveForeground);
      document.removeEventListener("visibilitychange", consumeOnForeground);
    };
  }, [active, rows, markAsRead, epicId, hostId, sessionId, tabId]);
}
