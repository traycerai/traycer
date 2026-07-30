import { flushSync } from "react-dom";
import type { LegendListRef } from "@legendapp/list/react";

/**
 * Preserves an anchor's own visual position across a disclosure state change
 * (segment/activity-group expand-collapse, chat find force-opening a reveal
 * chain). Port of T3's `MessagesTimeline.tsx` `onToggleWorkGroup` pattern,
 * generalized to replace `ChatMeasuredItemChangeContext`'s old
 * scroll-modifier-based approach: measure the anchor's top edge, apply the state
 * change synchronously (`flushSync`, so the DOM already reflects it once
 * this returns), then correct the scroll offset by exactly how far that
 * edge moved. Applies regardless of follow mode - a following reader who
 * expands content in the message they're currently reading should not be
 * yanked to the tail; a subsequent `maintainScrollAtEnd`/reveal-pass catch-up
 * (if any) runs as its own effect.
 *
 * The TOP edge (not bottom) is deliberate: it stays invariant to the
 * anchor's OWN growth (content added below a fixed top never moves that
 * top), so the same call is safe whether `anchorElement` is a rigid toggle
 * trigger sitting above the content it discloses (the original per-segment
 * use), or - when chat find force-opens a whole reveal chain that may or may
 * not include the row currently at the viewport's top edge (decision #21) -
 * a row that could itself be part of the mutating subtree. A bottom-edge
 * measurement would misfire in that second case, reporting the anchor's own
 * growth as a scroll-worthy shift when nothing above the viewport actually
 * moved.
 *
 * Review round (tickets 10/11/12, M2): `correctionOwnedByMvcp` - while
 * `sizePreservationEnabled`/`maintainVisibleContentPosition.size` is `true`
 * (free-scrolling), LegendList's OWN `ScrollAdjustHandler` ALSO reacts to
 * this disclosure's row-size change and applies its own compensating
 * `scrollTop` adjustment - proven additive (not self-cancelling) with this
 * helper's manual delta, an over-correction. Ownership is exclusive per
 * mode: `true` skips the manual correction below (the mutation still
 * applies via `flushSync` - only the scroll write is skipped, MVCP owns the
 * geometry); `false` (following-end / anchoring-new-turn, where
 * `sizePreservationEnabled` is `false` and MVCP never fires) corrects
 * exactly as before.
 */
export function preserveChatScrollAcrossDisclosureChange(input: {
  readonly list: Pick<LegendListRef, "getState" | "scrollToOffset"> | null;
  readonly anchorElement: HTMLElement | null;
  readonly mutate: () => void;
  readonly correctionOwnedByMvcp: boolean;
}): void {
  const { list, anchorElement, mutate, correctionOwnedByMvcp } = input;
  if (correctionOwnedByMvcp) {
    flushSync(mutate);
    return;
  }
  const anchorTopBefore = anchorElement?.getBoundingClientRect().top ?? null;

  flushSync(mutate);

  if (anchorTopBefore === null || anchorElement === null || list === null) {
    return;
  }

  const delta = anchorElement.getBoundingClientRect().top - anchorTopBefore;
  if (Math.abs(delta) < 0.5) {
    return;
  }

  const currentScroll = list.getState().scroll;
  void list.scrollToOffset({ offset: currentScroll + delta, animated: false });
}
