import { createContext, use } from "react";

/**
 * Which collapsible open-store a scroll target lives in, so landing on the card
 * also expands it. `subagent` → the promoted/subagent card; `tool` → a
 * tool_call / command / Monitor card.
 */
export type ChatScrollCardKind = "subagent" | "tool";

/**
 * Scrolls the chat transcript to the card that owns `blockId` and expands it.
 * Canvas-owned: the chat package only declares the intent; the tile renderer
 * resolves the owning message and drives Virtuoso + the open-stores. Mirrors
 * the background-panel row → card jump so both navigations behave identically.
 */
export type ScrollToChatBlock = (
  blockId: string,
  card: ChatScrollCardKind,
) => void;

export const ChatScrollToBlockContext = createContext<ScrollToChatBlock | null>(
  null,
);

/**
 * Returns the scroll-to-card handler, or `null` when there is no chat tile in
 * context (isolated render / tests) - callers then render the reference as
 * non-interactive.
 */
export function useScrollToChatBlock(): ScrollToChatBlock | null {
  return use(ChatScrollToBlockContext);
}
