import { createContext, useContext } from "react";

/** The three dock rows Layout ▸ Composer can fold into a chip. */
export type ChatDockSection = "filesChanged" | "activeAgents" | "background";

export interface ChatDockCompactChipModel {
  readonly section: ChatDockSection;
  /** The short form the chip prints: `+395 −12`, `3`, `2 · 1`. */
  readonly text: string;
  /** The whole sentence it stands for - the chip's accessible name. */
  readonly label: string;
  readonly pulseToken: string | null;
}

export interface ChatDockCompactStripValue {
  readonly chips: ReadonlyArray<ChatDockCompactChipModel>;
  readonly expanded: ReadonlySet<ChatDockSection>;
  readonly onToggle: (section: ChatDockSection) => void;
}

/**
 * Carries the folded dock rows down to the strip under the input.
 *
 * A context rather than a prop, because the two ends are a long way apart by
 * design: the rows live above the composer and the chips live inside it, in a
 * `workspaceControls` node the chat tile composes and hands over. Threading
 * counts through that would put a per-token-changing prop on the memoized
 * composer - the one thing `chat-tile-composer-rerender` exists to prevent -
 * and would bind the landing composer, which has no dock at all, to a shape it
 * has no use for.
 *
 * `null` is the no-dock case rather than an error: the landing composer and the
 * new-conversation modal build their own `workspaceControls` without a strip.
 */
export const ChatDockCompactStripContext =
  createContext<ChatDockCompactStripValue | null>(null);

export function useChatDockCompactStrip(): ChatDockCompactStripValue | null {
  return useContext(ChatDockCompactStripContext);
}

/**
 * True when this section is in the dock only because its chip was clicked.
 *
 * The panels read it themselves rather than taking it as a prop, for the same
 * reason the chips do: the answer travels from the strip under the input up
 * into the dock above it, and every component in between would otherwise carry
 * a flag it has no use for. Each panel reads it once, as the initial state of
 * its own collapsible - so a revealed row arrives OPEN (a chip click asked for
 * the panel, not for a second click), and closing it from there is the panel's
 * own business until the chip folds it away again.
 */
export function useChatDockSectionRevealed(section: ChatDockSection): boolean {
  const value = useChatDockCompactStrip();
  return value !== null && value.expanded.has(section);
}
