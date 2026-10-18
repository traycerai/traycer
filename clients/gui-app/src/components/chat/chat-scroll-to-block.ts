import { createContext, use } from "react";

/**
 * Which collapsible open-store a scroll target lives in, so landing on the card
 * also expands it. `subagent` → the promoted/subagent card; `tool` → a
 * tool_call / command / Monitor card; `plan` → the inline plan card (no store).
 */
export type ChatScrollCardKind = "subagent" | "tool" | "plan";

/**
 * Scrolls the chat transcript to the card that owns `blockId` and expands it.
 * Canvas-owned: the chat package only declares the intent; the tile renderer
 * resolves the owning message and drives the transcript list (LegendList) +
 * the open-stores. Mirrors the background-panel row → card jump so both
 * navigations behave identically.
 */
export type ScrollToChatBlock = (
  blockId: string,
  card: ChatScrollCardKind,
) => void;

export const ChatScrollToBlockContext = createContext<ScrollToChatBlock | null>(
  null,
);

/**
 * Scrolls to the row that showed the page `path@sha` (a stamp's
 * `derivedFrom`) and returns `true`, or returns `false` when this transcript
 * has no such row loaded. Same owner as {@link ScrollToChatBlock}.
 */
export type ScrollToChatPage = (pageRef: string) => boolean;

export const ChatScrollToPageContext = createContext<ScrollToChatPage | null>(
  null,
);

export function useScrollToChatPage(): ScrollToChatPage | null {
  return use(ChatScrollToPageContext);
}

/**
 * Returns the scroll-to-card handler, or `null` when there is no chat tile in
 * context (isolated render / tests) - callers then render the reference as
 * non-interactive.
 */
export function useScrollToChatBlock(): ScrollToChatBlock | null {
  return use(ChatScrollToBlockContext);
}
