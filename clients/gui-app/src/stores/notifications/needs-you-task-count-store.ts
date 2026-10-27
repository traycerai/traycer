import { create } from "zustand";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";
import { isActionableNotice } from "@/lib/notifications/notification-lifecycle";

/**
 * How many tasks need the person, counted as the window's tab strip sections
 * them: a split pair once, a task with no tab once. The strip publishes it,
 * and notification surfaces add actionable notices to that task count.
 * 0 while no strip is mounted.
 */
export const useNeedsYouTaskCountStore = create<{ readonly count: number }>(
  () => ({ count: 0 }),
);

export function useNeedsYouTaskCount(): number {
  return useNeedsYouTaskCountStore((state) => state.count);
}

/** Tasks retain their strip grouping; actionable notices each add one. */
export function useNotificationsNeedsYouCount(): number {
  const tasks = useNeedsYouTaskCount();
  const rows = useMergedNotificationRows();
  return (
    tasks +
    rows.filter((row) => isActionableNotice(row) && row.resolvedAt === null)
      .length
  );
}
