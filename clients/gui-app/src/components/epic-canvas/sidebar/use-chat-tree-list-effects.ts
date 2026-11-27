import type { ChatTreeVirtualApi } from "@/components/epic-canvas/sidebar/chat-tree-virtual-context";
import { useChatTreeFocusPins } from "@/components/epic-canvas/sidebar/use-chat-tree-focus-pins";
import { useChatTreeReveal } from "@/components/epic-canvas/sidebar/use-chat-tree-reveal";
import { useChatTreeScrollAnchor } from "@/components/epic-canvas/sidebar/use-chat-tree-scroll-anchor";

/**
 * Everything that works on the rendered chat tree through its virtual list,
 * called once, inside the list, with its live API. Each concern lives in its
 * own hook; this only runs them, in this order.
 */
export function useChatTreeListEffects(
  api: ChatTreeVirtualApi,
  tabId: string,
): void {
  useChatTreeScrollAnchor(api);
  useChatTreeReveal(api, tabId);
  useChatTreeFocusPins(api);
}
