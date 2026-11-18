import { create } from "zustand";
import { tabRefKey } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";

/**
 * The tab keys in the order the strip draws them, while that is not the
 * strip's own order (the Activity view lists its tabs in sections); `null`
 * while it is. The strip publishes it, and the tab-number and next/previous
 * shortcuts read it, so the Nth badge a person sees is the tab its digit
 * opens and the next tab is the row drawn below.
 */
export const useTabVisualOrderStore = create<{
  readonly keys: ReadonlyArray<string> | null;
}>(() => ({ keys: null }));

/** `tabs` in the order the strip draws them; a tab it does not list follows, in strip order. */
export function inVisualOrder(
  tabs: ReadonlyArray<HeaderTab>,
): ReadonlyArray<HeaderTab> {
  const { keys } = useTabVisualOrderStore.getState();
  if (keys === null) return tabs;
  const rank = new Map(keys.map((key, index) => [key, index]));
  return [...tabs].sort(
    (a, b) =>
      (rank.get(tabRefKey(a)) ?? keys.length) -
      (rank.get(tabRefKey(b)) ?? keys.length),
  );
}
