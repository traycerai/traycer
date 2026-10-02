import { create } from "zustand";

/**
 * How many tasks need the person, counted as the window's tab strip sections
 * them: a split pair once, a task with no tab once. The strip publishes it,
 * and every Needs you count outside the strip's list reads it (the
 * Notifications row and tile, the header's bell), so each says the number the
 * Needs you header does. 0 while no strip is mounted.
 */
export const useNeedsYouTaskCountStore = create<{ readonly count: number }>(
  () => ({ count: 0 }),
);

export function useNeedsYouTaskCount(): number {
  return useNeedsYouTaskCountStore((state) => state.count);
}
