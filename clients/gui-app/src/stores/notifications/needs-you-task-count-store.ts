import { create } from "zustand";

/**
 * How many tasks need the person, counted as the window's tab strip sections
 * them: a split pair once, a task with no tab once. The strip publishes it.
 * 0 while no strip is mounted.
 */
export const useNeedsYouTaskCountStore = create<{ readonly count: number }>(
  () => ({ count: 0 }),
);

/** The notification surfaces' "needs you" count: the tasks alone. */
export function useNotificationsNeedsYouCount(): number {
  return useNeedsYouTaskCountStore((state) => state.count);
}
