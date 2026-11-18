import { useReducedMotion } from "motion/react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { subscribeClosingTabs } from "@/stores/tabs/strip-motion";
import { selectedStripMember } from "./use-strip-scroller";

/**
 * A closed tab's slot closes up instead of vanishing.
 *
 * The closed item is gone from the store by the time the strip renders, so
 * there is nothing of it left to animate. Instead the strip measures its
 * members just before the close lands, and afterwards puts an empty spacer
 * where each run of closed members was, as wide as that run. The strip then
 * paints exactly as it did before the close, and the spacer
 * (`StripExitGhostSpacer`) shrinks to nothing so the neighbours close the gap.
 *
 * The spacer takes the closed members' own width, not the distance the
 * survivors moved: under the shrink layout every surviving tab also widens
 * when one closes, so the move is smaller than the gap. A spacer as wide as
 * the closed tab gives the flex layout back exactly the space it had. Less
 * whatever took the closed members' place: closing one side of a split
 * replaces the split with a lone tab, and only the difference closes up.
 */

/** A snapshot no layout change used this soon was taken for a close that never landed. */
const SNAPSHOT_TTL_MS = 500;
/** Sub-pixel runs are layout rounding, not a closed slot. */
const MIN_GAP_PX = 0.5;
const TRAILING = null;

export interface StripExitGhost {
  readonly key: string;
  /** The member the spacer sits right before; `null` is after the last one. */
  readonly beforeAnchor: string | null;
  readonly width: number;
}

/**
 * One child of the strip in flow order: a member (`item:` or `chip:`) or a
 * spacer still closing (`ghost:`), with the start of its margin box in content
 * coordinates, so a chip's margins belong to the chip.
 */
interface StripSlot {
  readonly key: string;
  readonly start: number;
}

export interface StripGeometry {
  readonly slots: ReadonlyArray<StripSlot>;
  readonly end: number;
  readonly scrollLeft: number;
}

export function ghostSlotKey(ghostKey: string): string {
  return `ghost:${ghostKey}`;
}

/** A slot runs up to the next slot's start, so a chip's margins come with it. */
function slotSpan(geometry: StripGeometry, index: number): number {
  const slot = geometry.slots.at(index);
  if (slot === undefined) return 0;
  return (geometry.slots.at(index + 1)?.start ?? geometry.end) - slot.start;
}

/**
 * The spacers that keep every surviving member where it was.
 *
 * Walking the strip as it was, each slot that is gone now adds its span to
 * the gap before the next member that survived, and each slot that is new in
 * the same stretch takes its span back. A spacer whose member is gone is such
 * a slot too, so its remaining width folds into the new gap; a new gap right
 * before a spacer that is still closing merges into it.
 */
export function ghostsForClose(input: {
  readonly before: StripGeometry;
  readonly after: StripGeometry;
  readonly current: ReadonlyArray<StripExitGhost>;
  readonly nextKey: () => string;
}): ReadonlyArray<StripExitGhost> {
  const { before, after, current, nextKey } = input;
  const presentBefore = new Set(before.slots.map((slot) => slot.key));
  const presentNow = new Set(after.slots.map((slot) => slot.key));
  const isAnchor = (key: string) => !key.startsWith("ghost:");

  // What appeared in each stretch, keyed by the survivor that ends it.
  const addedBefore = new Map<string | null, number>();
  let added = 0;
  after.slots.forEach((slot, index) => {
    if (!presentBefore.has(slot.key)) {
      added += slotSpan(after, index);
      return;
    }
    if (!isAnchor(slot.key)) return;
    addedBefore.set(slot.key, added);
    added = 0;
  });
  addedBefore.set(TRAILING, added);

  const next = new Map(
    current
      .filter((ghost) => presentNow.has(ghostSlotKey(ghost.key)))
      .map((ghost) => [ghost.beforeAnchor, ghost]),
  );
  const addGap = (anchor: string | null, removed: number): void => {
    const gap = removed - (addedBefore.get(anchor) ?? 0);
    if (gap <= MIN_GAP_PX) return;
    const existing = next.get(anchor);
    const remaining =
      existing === undefined
        ? 0
        : slotSpan(
            after,
            after.slots.findIndex(
              (slot) => slot.key === ghostSlotKey(existing.key),
            ),
          );
    next.set(anchor, {
      key: nextKey(),
      beforeAnchor: anchor,
      width: gap + remaining,
    });
  };
  let removed = 0;
  before.slots.forEach((slot, index) => {
    if (!presentNow.has(slot.key)) {
      removed += slotSpan(before, index);
      return;
    }
    // Spacers are not anchors: a gap before one belongs before its member.
    if (!isAnchor(slot.key)) return;
    addGap(slot.key, removed);
    removed = 0;
  });
  addGap(TRAILING, removed);
  return [...next.values()];
}

function slotKeyOf(element: HTMLElement): string | null {
  const { stripItemId, stripGroupChip, stripExitGhost } = element.dataset;
  if (stripItemId !== undefined) return `item:${stripItemId}`;
  if (stripGroupChip !== undefined) return `chip:${stripGroupChip}`;
  if (stripExitGhost !== undefined) return ghostSlotKey(stripExitGhost);
  // Anything else (the absolute selection traveller) is not in the flow.
  return null;
}

export function measureStripGeometry(scroller: HTMLElement): StripGeometry {
  const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft;
  const slots: StripSlot[] = [];
  let end = 0;
  for (const child of scroller.children) {
    if (!(child instanceof HTMLElement)) continue;
    const key = slotKeyOf(child);
    if (key === null) continue;
    const box = child.getBoundingClientRect();
    const margins = getComputedStyle(child);
    slots.push({
      key,
      start: box.left - Number.parseFloat(margins.marginLeft) - origin,
    });
    end = Math.max(
      end,
      box.right + Number.parseFloat(margins.marginRight) - origin,
    );
  }
  return { slots, end, scrollLeft: scroller.scrollLeft };
}

/**
 * A closed selection hands over to a neighbour that may be out of view. The
 * spacers before it are about to shrink and carry it left by their width, so
 * it is revealed where it will land, not where it is drawn now.
 */
function revealWhereItLands(scroller: HTMLElement): void {
  const member = selectedStripMember(scroller);
  if (member === null) return;
  let closing = 0;
  for (const child of scroller.children) {
    if (child === member) break;
    if (
      child instanceof HTMLElement &&
      child.dataset.stripExitGhost !== undefined
    )
      closing += child.getBoundingClientRect().width;
  }
  const box = member.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const start = box.left - closing;
  const end = box.right - closing;
  if (end > view.right) scroller.scrollLeft += end - view.right;
  else if (start < view.left) scroller.scrollLeft -= view.left - start;
}

/**
 * `drawnRowsKey` changes whenever the strip's rows or what it draws of them
 * do. That commit may be the one a close landed in, or one that stopped
 * drawing a spacer (its group collapsed), which is then forgotten rather than
 * replayed at full width when the group expands.
 */
export function useStripExitGhosts(
  scrollerRef: RefObject<HTMLDivElement | null>,
  drawnRowsKey: string,
): {
  readonly ghosts: ReadonlyArray<StripExitGhost>;
  readonly settleGhost: (key: string) => void;
} {
  const reduceMotion = useReducedMotion() === true;
  const [ghosts, setGhosts] = useState<ReadonlyArray<StripExitGhost>>([]);
  const snapshotRef = useRef<{
    readonly at: number;
    readonly geometry: StripGeometry;
  } | null>(null);
  const keyCounterRef = useRef(0);
  // Reading layout before the spacers mount clamps a strip scrolled to its
  // end by the closed width; the spacers give that width back, so the offset
  // the close found is put back with them.
  const restoreScrollRef = useRef<number | null>(null);

  useLayoutEffect(
    () =>
      subscribeClosingTabs(() => {
        const scroller = scrollerRef.current;
        if (reduceMotion || scroller === null) return;
        const now = performance.now();
        // Close Other Tabs closes several tabs in one gesture: they share the
        // strip as it was before the first of them.
        const pending = snapshotRef.current;
        if (pending !== null && now - pending.at < SNAPSHOT_TTL_MS) return;
        snapshotRef.current = {
          at: now,
          geometry: measureStripGeometry(scroller),
        };
      }),
    [scrollerRef, reduceMotion],
  );

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    if (scroller === null) return;
    const after = measureStripGeometry(scroller);
    const fresh =
      snapshot !== null && performance.now() - snapshot.at < SNAPSHOT_TTL_MS;
    if (fresh) restoreScrollRef.current = snapshot.geometry.scrollLeft;
    // StrictMode calls the updater twice; the discarded call only skips a
    // few key numbers.
    const nextKey = () => {
      keyCounterRef.current += 1;
      return `strip-exit-ghost-${keyCounterRef.current}`;
    };
    setGhosts((current) => {
      if (fresh) {
        return ghostsForClose({
          before: snapshot.geometry,
          after,
          current,
          nextKey,
        });
      }
      // No close to answer for, but a spacer whose member left some other
      // way (a drag, a split, a collapsed group) is no longer rendered;
      // forget it.
      const present = new Set(after.slots.map((slot) => slot.key));
      const kept = current.filter((ghost) =>
        present.has(ghostSlotKey(ghost.key)),
      );
      return kept.length === current.length ? current : kept;
    });
  }, [scrollerRef, drawnRowsKey]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const scrollLeft = restoreScrollRef.current;
    restoreScrollRef.current = null;
    if (scroller === null || scrollLeft === null) return;
    scroller.scrollLeft = scrollLeft;
    revealWhereItLands(scroller);
  }, [scrollerRef, ghosts]);

  const settleGhost = useCallback((key: string) => {
    setGhosts((current) => current.filter((ghost) => ghost.key !== key));
  }, []);
  return { ghosts, settleGhost };
}
