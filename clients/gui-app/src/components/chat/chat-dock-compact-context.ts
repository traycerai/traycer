import { createContext, useContext } from "react";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";

/**
 * What a pill draws ahead of its number - what the section IS, never what it
 * is doing. Activity rides on top of this glyph (see `working`) rather than
 * replacing it: a pill whose icon is swapped out while busy stops saying which
 * section it stands for at exactly the moment someone is scanning for it, and
 * two busy pills side by side then read as the same thing twice.
 *
 * One member per section, and the Background one is deliberately not a
 * per-kind borrow any more. The pill used to take the icon of the one kind its
 * rows shared and a neutral stack when they differed, so the same pill was a
 * bot, a clock, a terminal or a pile of layers depending on what happened to
 * be in the panel - and a reader scanning the strip for "the background pill"
 * had to know the panel's contents to find it. The section's own mark, the
 * chat-with-a-clock the notification indicators use for background work, is
 * the one thing that says "background" wherever it appears. The panel's rows
 * keep their per-kind icons; that is where a kind is worth telling apart.
 */
export type ChatDockCompactChipGlyph = ChatDockSection;

export interface ChatDockCompactChipModel {
  readonly section: ChatDockSection;
  readonly glyph: ChatDockCompactChipGlyph;
  /** This pill's Customize hotspot - it is the member's one anchor (L-142). */
  readonly hotspotRef: ((node: HTMLElement | null) => void) | null;
  /**
   * True while something in this section is in flight.
   *
   * A pill is `[icon] N` and nothing else, so the state is carried by the icon:
   * the glyph in `primary`, shimmering on the shared status clock, and the
   * count in `primary` beside it. It never changes WHICH icon - the glyph is
   * the only thing saying which section a pill stands for.
   *
   * The pill used to print the word for it too (`1 running`), on a container
   * query against the composer row. That word is gone: it said what three
   * channels of the icon already say, in the one place the composer has least
   * room, and it gave the two pills two vocabularies for one state. The
   * sentence in `label` still carries it, which is the channel that cannot show
   * a tone or a pulse.
   */
  readonly working: boolean;
  /** The short form the pill prints: `+395 −12`, `3`, `2 · 1`, `2/5`. */
  readonly text: string;
  /**
   * Line counts to draw after the number, in the tones the panel uses - the
   * Files changed pill, and nothing else so far. `null` is a pill with no
   * second measurement to show, not a pill whose counts are zero: zero counts
   * are a `DiffLineCounts` that simply prints nothing, so a summary still in
   * flight collapses to the file count on its own.
   */
  readonly lineDeltas: DiffLineCounts | null;
  /** The whole sentence it stands for - the pill's accessible name. */
  readonly label: string;
  /**
   * The pill's counts, worded for the SECOND line of its tooltip (L-153):
   * "3 files, +47 \u22129" in shape, never a sentence and never the member's own
   * name, which the first line already carries and which this model already
   * knows from `section`.
   *
   * A field of its own rather than a slice of `label`, because the two are
   * worded for different readers and already differ: the accessible sentence
   * spells "47 lines added, 4 removed" because a screen reader cannot hear a
   * `+` or a tone, while the tooltip prints the same pair of signs the pill
   * itself prints, beside the pill that prints them.
   */
  readonly detail: string;
  readonly pulseToken: string | null;
}

export interface ChatDockCompactStripValue {
  readonly chips: ReadonlyArray<ChatDockCompactChipModel>;
  /**
   * The one section whose panel is attached above the composer, or `null` for
   * a closed strip (L-142).
   *
   * One value, not a set: the pills are a switcher, so clicking another pill
   * REPLACES what is open rather than stacking a second panel on the composer.
   */
  readonly openSection: ChatDockSection | null;
  /** The DOM id of the attached panel, for the open pill's `aria-controls`. */
  readonly panelId: string;
  readonly onToggle: (section: ChatDockSection) => void;
}

/**
 * Carries the folded dock rows down to the strip under the input.
 *
 * A context rather than a prop, because the two ends are a long way apart by
 * design: the rows live above the composer and the pills live inside it, in a
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
 * True when this section is the one attached above the composer right now.
 *
 * The panels read it themselves rather than taking it as a prop, for the same
 * reason the pills do: the answer travels from the strip under the input up
 * into the dock above it, and every component in between would otherwise carry
 * a flag it has no use for. A member is EITHER a pill or a full row, never
 * both, so this is exact rather than a hint: an attached panel drops its
 * collapsible header entirely (the pill is its header) and sends its actions
 * to the pill row.
 */
export function useChatDockSectionAttached(section: ChatDockSection): boolean {
  const value = useChatDockCompactStrip();
  return value !== null && value.openSection === section;
}
