import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useDroppable } from "@dnd-kit/core";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  revealMemberAlongAxis,
  type StripAxis,
} from "@/components/epic-canvas/dnd/strip-axis";
import { runHeaderStripCommitHandoff } from "./header-strip-commit-handoff";
import {
  HEADER_TAB_SLOT_DND_TYPE,
  HEADER_TAB_TRAILING_SLOT_DROP_ID,
  type HeaderTabSlotDropData,
} from "./header-tab-dnd";

/**
 * The DOM mechanics every tab strip's scroller shares, along the strip's own
 * axis: the commit re-base over every strip item, keeping the active member
 * in view (L-146), and the trailing drop slot. Returns the callback ref for
 * the scrolling element; `extraRef` also receives it.
 */
export function useStripScroller(input: {
  readonly axis: StripAxis;
  readonly activeItemId: string | null;
  readonly itemCount: number;
  readonly extraRef: ((node: HTMLDivElement | null) => void) | null;
}): (node: HTMLDivElement | null) => void {
  const { axis, activeItemId, itemCount, extraRef } = input;
  // Parent layout effects run AFTER every child's, so by here every strip item
  // has registered and published its current target. Driving the re-base from
  // this one boundary is what makes it reach EVERY item whose baseline moved -
  // an earlier per-item version reached only the items React happened to
  // re-render, which is one tab per commit.
  useLayoutEffect(() => {
    runHeaderStripCommitHandoff(axis);
  });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The strip may not cut the tab that holds the selection in half.
  //
  // The scroller overflows along the strip's axis, and nothing scrolled a tab
  // into view - so with enough tabs open the layout editor's own tab was
  // appended past the edge and CLIPPED there. That single clip produced all
  // three things the owner's third live pass reported as one broken tab: the
  // label read "Sample" because the glyphs past the edge were gone, the amber
  // outline covered only part of the silhouette, and the mark inside it ended
  // on a razor edge. None of them was a paint bug; the tab was simply half
  // off-screen.
  //
  // That fix was scoped to the session tab's marker, which left the general
  // case - any tab that becomes active while clipped - exactly as broken, and
  // worst where there is no pointer to say where the tab went: a keyboard walk
  // through the strip, a leader chord, a palette jump, a tab activated by a
  // close. The reveal is the selection's, not the editing indicator's (L-146).
  //
  // Instant, never smooth: activation is frequent and often held down on a
  // keyboard, and an animated strip under a repeating chord is a strip that is
  // permanently mid-flight and never at the tab the user is on.
  const revealActiveMember = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (scroller !== null) revealSelectedMember(scroller, axis);
  }, [axis]);
  // On the activation CHANGE, and in a layout effect so the reveal lands in
  // the same paint as the newly active tab. Deliberately NOT on every render:
  // the strip is a scroller the user also drives by hand, and a per-commit
  // reveal would haul their position back on every unrelated re-render. The
  // item count rides along because opening or closing a tab moves the active
  // one without changing which tab it is.
  useLayoutEffect(() => {
    revealActiveMember();
  }, [activeItemId, itemCount, revealActiveMember]);
  // The other way a whole tab becomes a clipped one, with no activation to key
  // on: the strip shrinks under it - a window resize, a panel opening beside
  // it, a collapse. Writing the scroll offset changes no box, so this cannot
  // re-enter.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const observer = new ResizeObserver(() => {
      revealActiveMember();
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [revealActiveMember]);
  // Trailing slot: the strip's empty space after the last item accepts drops
  // at index `itemCount` (both reorder and tear-off).
  const trailingSlotData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: itemCount,
      isTrailing: true,
    }),
    [itemCount],
  );
  const { setNodeRef: trailingSlotRef } = useDroppable({
    id: HEADER_TAB_TRAILING_SLOT_DROP_ID,
    data: trailingSlotData,
  });
  // One stable callback ref for all three owners: a fresh callback ref on
  // every render detaches and re-attaches the node on every owner every
  // commit - which for dnd-kit means the drop slot is momentarily
  // unregistered mid-drag.
  return useCallback(
    (node: HTMLDivElement | null): void => {
      trailingSlotRef(node);
      scrollerRef.current = node;
      if (extraRef !== null) extraRef(node);
    },
    [trailingSlotRef, extraRef],
  );
}

/**
 * Scroll the strip the least amount that brings the selected member into view.
 * Exported for the strip's slot animations, which move the selection after
 * the activation reveal has already run: a slot opening beside it, or the
 * selected slot itself growing from nothing.
 */
export function revealSelectedMember(
  scroller: HTMLElement,
  axis: StripAxis,
): void {
  // Mid-drag the strip's geometry belongs to dnd-kit: members carry
  // displacement transforms, the dragged tab follows the pointer, and the
  // drag model re-reads this very scroll offset as its content origin. A
  // reveal here would measure a transient box AND move the ground under the
  // gesture, so a drag is simply not a moment to reveal anything.
  if (useEpicDndStore.getState().activeHeaderTab !== null) return;
  // The selection as the strip PAINTED it - no second reading of
  // `activeItemId` that could disagree with the tab that drew itself active.
  // Exactly one node inside the scroller carries it: a split group's halves
  // are selected only while the group itself holds the selection, and Home
  // is drawn outside the scroller.
  const selected = scroller.querySelector<HTMLElement>(
    '[aria-selected="true"]',
  );
  if (selected === null) return;
  // The strip MEMBER, not the selected node: inside a split group the
  // selected node is one half of the member. Walking to the scroller's own
  // child is what gets the element whose box is the whole item.
  let member: HTMLElement | null = selected;
  while (member !== null && member.parentElement !== scroller) {
    member = member.parentElement;
  }
  if (member === null) return;
  revealMemberAlongAxis(scroller, member, axis);
}
