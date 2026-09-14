import { createContext, useContext } from "react";
import type { BackgroundItemKind } from "@traycer/protocol/host/agent/gui/subscribe";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";

/** The three dock rows Layout ▸ Composer can fold into a chip. */
export type ChatDockSection = "filesChanged" | "activeAgents" | "background";

/**
 * What a chip draws ahead of its number - what the section IS, never what it
 * is doing. Activity rides on top of this glyph (see `working`) rather than
 * replacing it: a chip whose icon is swapped out while busy stops saying which
 * section it stands for at exactly the moment someone is scanning for it, and
 * two busy chips side by side then read as the same thing twice.
 *
 * The Background chip has no icon of its own. It borrows the icon of the one
 * kind its rows share - a wake, a sub-agent - and shows a neutral stack
 * (`mixed`) when they differ, exactly as the panel's rows would draw them.
 * `managedShell` is the host-supervised shell, which the panel draws from its
 * own glyph family rather than from the kind icons; on the chip it is always a
 * terminal, running or held. The panel keeps its pause glyph for the held ROW,
 * where the word "Held" is right beside it; a chip has no such word, so a pause
 * on a live watcher read as "this shell is paused" - which is how a shell
 * following a PR came to be drawn as stopped.
 */
export type ChatDockCompactChipGlyph =
  | "filesChanged"
  | "activeAgents"
  | "managedShell"
  | "mixed"
  | BackgroundItemKind;

export interface ChatDockCompactChipModel {
  readonly section: ChatDockSection;
  readonly glyph: ChatDockCompactChipGlyph;
  /**
   * True while something in this section is in flight.
   *
   * A chip is `[icon] N` and nothing else, so the state is carried by the icon:
   * the glyph in `primary`, shimmering on the shared status clock, with a ping
   * at its corner, and the count in `primary` beside it. It never changes WHICH
   * icon - the glyph is the only thing saying which section a chip stands for.
   *
   * The chip used to print the word for it too (`1 running`), on a container
   * query against the composer row. That word is gone: it said what three
   * channels of the icon already say, in the one place the composer has least
   * room, and it gave the two chips two vocabularies for one state. The
   * sentence in `label` still carries it, which is the channel that cannot show
   * a tone or a pulse.
   */
  readonly working: boolean;
  /** The short form the chip prints: `+395 −12`, `3`, `2 · 1`. */
  readonly text: string;
  /**
   * Line counts to draw after the number, in the tones the panel uses - the
   * Files changed chip, and nothing else so far. `null` is a chip with no
   * second measurement to show, not a chip whose counts are zero: zero counts
   * are a `DiffLineCounts` that simply prints nothing, so a summary still in
   * flight collapses to the file count on its own.
   */
  readonly lineDeltas: DiffLineCounts | null;
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
