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
  useEffect(() => {
    if (!active) {
      consumed.current.clear();
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
    consume();
    window.addEventListener("focus", consume);
    document.addEventListener("visibilitychange", consume);
    return () => {
      window.removeEventListener("focus", consume);
      document.removeEventListener("visibilitychange", consume);
    };
  }, [active, rows, markAsRead, epicId, hostId, sessionId, tabId]);
}
