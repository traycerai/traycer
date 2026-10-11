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
import { registerTabStripGeometry } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { runHeaderStripCommitHandoff } from "./header-strip-commit-handoff";
import { readTranslate } from "./header-strip-geometry";
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
  const { axis, itemCount, extraRef } = input;
  // Parent layout effects run AFTER every child's, so by here every strip item
  // has registered and published its current target. Driving the re-base from
  // this one boundary is what makes it reach EVERY item whose baseline moved -
  // an earlier per-item version reached only the items React happened to
  // re-render, which is one tab per commit.
  useLayoutEffect(() => {
    runHeaderStripCommitHandoff(axis);
  });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = scrollerRef.current;
    // The horizontal header registers through `useHiddenHeaderTabs`, which
    // also publishes its edge-menu snapshot. Keyed on the axis, not on
    // `extraRef`: the side strip takes an `extraRef` of its own (its section
    // scroll) and still needs its reveal from here.
    if (element === null || axis.id === "x") return;
    return registerTabStripGeometry(element, axis, () => {});
  }, [axis]);
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
 * The strip member that holds the selection as the strip PAINTED it - no
 * second reading of `activeItemId` that could disagree with the tab that drew
 * itself active. Exactly one node inside the scroller carries it: a split
 * group's halves are selected only while the group itself holds the
 * selection, and Home is drawn outside the scroller. `null` mid-drag: the
 * strip's geometry then belongs to dnd-kit, whose members carry displacement
 * transforms and whose drag model reads the scroll offset as its content
 * origin, so a drag is not a moment to reveal anything.
 */
export function selectedStripMember(scroller: HTMLElement): HTMLElement | null {
  if (useEpicDndStore.getState().activeHeaderTab !== null) return null;
  const selected = scroller.querySelector<HTMLElement>(
    '[aria-selected="true"]',
  );
  // The strip MEMBER, not the selected node: inside a split group the
  // selected node is one half of the member. Walking to the scroller's own
  // child is what gets the element whose box is the whole item.
  let member: HTMLElement | null = selected;
  while (member !== null && member.parentElement !== scroller) {
    member = member.parentElement;
  }
  return member;
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
  const member = selectedStripMember(scroller);
  if (member !== null) {
    revealMemberAlongAxis(scroller, member, axis, readTranslate(member, axis));
  }
}
