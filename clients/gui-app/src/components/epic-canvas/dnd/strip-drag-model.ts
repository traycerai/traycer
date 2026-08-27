/**
 * Geometry model for header-strip tab dragging.
 *
 * Chrome does not hit-test droppables to decide a reorder, and neither does
 * this: the insertion index is a pure function of the pointer's x against tab
 * widths measured once at drag start. That is what makes the result stable.
 * Resolving against live droppables re-enters the loop it is driving - the
 * provisional order moves a tab under the pointer, which changes the hit, which
 * changes the provisional order - and the strip oscillates.
 *
 * Two properties are load-bearing and both fall out of the swap rule rather
 * than being tuned in:
 *
 * - **Monotonicity.** A monotone pointer sweep yields a monotone index.
 * - **Hysteresis.** After a swap the neighbour's centre has moved, so reversing
 *   requires re-crossing `sourceWidth + 2 * bandPx` - see `swapHysteresisPx`.
 *   Note this is the SOURCE's width, not the mean of the pair: the two coincide
 *   only for equal-width items, and a split group is one strip item of its own
 *   width.
 *
 * Merge (pair-into-split) shares the model so the two gestures cannot disagree
 * about where a boundary is. The merge band sits around a neighbour's centre and
 * the swap boundary sits `bandPx` PAST that centre, so the band is reachable and
 * dwellable. Nothing is ever held in time: the boundary is shifted in x, so the
 * dragged tab moves continuously at every pointer position and a pass never
 * stalls.
 */

/**
 * Half-width of the merge band around a neighbour's centre, in CSS px, for a
 * strip whose tabs can be PAIRED into a split - the header.
 *
 * It is a per-gesture parameter (`StripDragGeometry.mergeBandPx`) rather than a
 * module constant because the two strips differ: header tabs pair, tile tabs do
 * not. A tile strip passes 0, which puts its swap boundary exactly at the
 * neighbour's centre - Chrome's own rule.
 */
export const HEADER_MERGE_BAND_PX = 16;

/**
 * Tile strips have no pair gesture, so no band and no merge state.
 *
 * Band 0 does NOT by itself make the merge branch unreachable: the test is
 * `distance <= bandPxFor(w, 0)`, i.e. `distance <= 0`, which is satisfiable at
 * exactly 0. What makes it unreachable on tile strips is `isMergeTarget: false`
 * from `readTileStripSlots`, and that is what the coverage relies on.
 */
export const TILE_MERGE_BAND_PX = 0;

/** Stationary time inside the band before a merge preview arms. */
export const MERGE_DWELL_MS = 400;

/** Pointer travel that re-anchors an arming dwell, in CSS px. */
export const MERGE_STILLNESS_PX = 6;

export interface StripSlot {
  readonly itemId: string;
  readonly width: number;
  /** Left edge in the strip's CONTENT box, so scrolling cannot invalidate it. */
  readonly contentLeft: number;
  /**
   * Distance from this slot's left edge to the next slot's, measured rather
   * than assumed. Prefix-summing raw widths would silently bias every centre
   * by an accumulating amount if any wrapper carries margin, padding or a
   * border - worst at the right end of the strip, and invisible to a unit test
   * that generates its own contiguous geometry.
   */
  readonly advance: number;
  /**
   * Whether this item can be merged into. A split group cannot: the pair target
   * carries a single `TabRef` and a two-ref item has no unambiguous one.
   */
  readonly isMergeTarget: boolean;
}

export interface StripDragGeometry {
  readonly slots: ReadonlyArray<StripSlot>;
  readonly sourceIndex: number;
  /** `pointerDownX - sourceRect.left`, held for the life of the gesture. */
  readonly grabOffsetX: number;
  /**
   * The source tab's viewport left at drag start. dnd-kit positions the overlay
   * from this rect, so every overlay calculation must be expressed against it -
   * never against a live rect, which tracks the placeholder as it slides.
   */
  readonly sourceInitialLeft: number;
  readonly sourceWidth: number;
  /** Per-strip: `HEADER_MERGE_BAND_PX` for the header, `TILE_MERGE_BAND_PX` for tiles. */
  readonly mergeBandPx: number;
  readonly stripTop: number;
  readonly stripBottom: number;
}

export type StripDragState =
  | { readonly kind: "reorder"; readonly targetIndex: number }
  | {
      readonly kind: "merge-armed";
      readonly targetIndex: number;
      readonly targetItemId: string;
      readonly armedAtMs: number;
      readonly armedAtPointerX: number;
    }
  | {
      readonly kind: "merge-preview";
      readonly targetIndex: number;
      readonly targetItemId: string;
    };

export interface ResolveStripDragInput {
  readonly geometry: StripDragGeometry;
  /**
   * Viewport x of the strip's content origin, re-read every frame as
   * `stripRect.left - stripEl.scrollLeft`. The strip scrolls mid-drag - by
   * wheel and by dnd-kit autoScroll - and a cached origin desyncs every
   * neighbour centre with no recovery.
   */
  readonly contentOriginX: number;
  readonly pointerX: number;
  readonly previous: StripDragState | null;
  readonly nowMs: number;
}

/** The merge band never eats more than a quarter of a narrow item. */
export function bandPxFor(width: number, mergeBandPx: number): number {
  return Math.min(mergeBandPx, width * 0.25);
}

/**
 * Distance the pointer must travel back before a just-made swap reverses.
 * Derived: swap-right fires at `L + w_s + w_n/2 + b`; after the swap the
 * neighbour occupies `[L, L + w_n]` so swap-left fires at `L + w_n/2 - b`.
 * The `w_n` terms cancel.
 */
export function swapHysteresisPx(
  sourceWidth: number,
  neighbourWidth: number,
  mergeBandPx: number,
): number {
  return sourceWidth + 2 * bandPxFor(neighbourWidth, mergeBandPx);
}

/**
 * Visual order with the source moved to `targetIndex`. Both indices are in the
 * ORIGINAL coordinate space, which is also what the commit APIs take.
 */
export function provisionalStripOrder<T>(
  items: ReadonlyArray<T>,
  sourceIndex: number,
  targetIndex: number,
): ReadonlyArray<T> {
  if (
    sourceIndex < 0 ||
    sourceIndex >= items.length ||
    targetIndex < 0 ||
    targetIndex >= items.length ||
    targetIndex === sourceIndex
  ) {
    return items;
  }
  const next = [...items];
  const [source] = next.splice(sourceIndex, 1);
  if (source === undefined) return items;
  next.splice(targetIndex, 0, source);
  return next;
}

/**
 * Convert the model's FINAL-POSITION index into the INSERTION index
 * `reorderStripItem` takes. That reducer splices the item out first and then
 * applies `from < target ? target - 1 : target`, so handing it a final position
 * directly is off by one for every rightward move.
 */
export function insertionIndexForTarget(
  sourceIndex: number,
  targetIndex: number,
): number {
  return targetIndex >= sourceIndex ? targetIndex + 1 : targetIndex;
}

/**
 * Where the dragged tab's overlay should sit, in VIEWPORT x.
 *
 * Derived from the pointer, not from a drag delta, and expressed in one
 * coordinate frame end to end. Both matter:
 *
 * - Deriving it from the pointer means the overlay and the model agree about
 *   where the tab is by construction, and the first painted frame is already
 *   correct rather than lagging the activation distance.
 * - Mixing frames is what makes this fail invisibly. Clamping against a rect
 *   that tracks the source PLACEHOLDER - which slides as the provisional order
 *   changes - while the transform is measured from the tab's ORIGINAL position
 *   pins the overlay at the source's original right edge partway through a
 *   drag. On the second-to-last tab that pinned value coincides with the
 *   correct bound, so the bug is invisible on exactly one strip position.
 */
export function overlayLeftForPointer(input: {
  readonly pointerX: number;
  readonly grabOffsetX: number;
  readonly sourceWidth: number;
  readonly stripLeft: number;
  readonly stripRight: number;
}): number {
  const desired = input.pointerX - input.grabOffsetX;
  const maxLeft = Math.max(
    input.stripLeft,
    input.stripRight - input.sourceWidth,
  );
  return Math.min(Math.max(desired, input.stripLeft), maxLeft);
}

/**
 * Per-item x displacement, in px, for a strip rendering a provisional order.
 *
 * `targetIndex === null` means the dragged item has LEFT this strip (it is over
 * another group), so the strip closes the gap: everything after the source
 * shifts left by the source's advance and the source itself is not displaced,
 * since it is invisible and belongs to another strip's layout now.
 *
 * Returned as explicit offsets rather than a CSS `order` because binding the
 * transform to state is what makes a stranded transform unrepresentable.
 */
export function stripOffsetsFor(
  geometry: StripDragGeometry,
  targetIndex: number | null,
): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  const { slots, sourceIndex } = geometry;
  if (sourceIndex < 0 || sourceIndex >= slots.length) return offsets;
  const source = slots[sourceIndex];

  if (targetIndex === null) {
    for (let i = sourceIndex + 1; i < slots.length; i += 1) {
      const slot = slots[i];
      offsets.set(slot.itemId, -source.advance);
    }
    return offsets;
  }

  // Natural left of each slot, then its left in the provisional order.
  const naturalLeft = new Map<string, number>();
  let cursor = 0;
  for (const slot of slots) {
    naturalLeft.set(slot.itemId, cursor);
    cursor += slot.advance;
  }
  const ordered = provisionalStripOrder(slots, sourceIndex, targetIndex);
  cursor = 0;
  for (const slot of ordered) {
    offsets.set(slot.itemId, cursor - (naturalLeft.get(slot.itemId) ?? 0));
    cursor += slot.advance;
  }
  return offsets;
}

/**
 * Offsets for a strip the dragged item is being INSERTED into from another
 * group: it has no slot here, so everything from `insertIndex` onwards opens a
 * gap of `insertWidth`.
 */
export function insertionOffsetsFor(
  slots: ReadonlyArray<StripSlot>,
  insertIndex: number,
  insertWidth: number,
): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  slots.forEach((slot, index) => {
    offsets.set(slot.itemId, index >= insertIndex ? insertWidth : 0);
  });
  return offsets;
}

/**
 * Insertion index for an item arriving from ANOTHER strip: it owns no slot
 * here, so there is no source to skip and no hysteresis to carry - the index is
 * simply how many slot centres the pointer has passed.
 */
export function insertionIndexFromPointer(
  slots: ReadonlyArray<StripSlot>,
  contentOriginX: number,
  pointerX: number,
): number {
  let cursor = contentOriginX + (slots[0]?.contentLeft ?? 0);
  let index = 0;
  for (const slot of slots) {
    if (pointerX < cursor + slot.width / 2) return index;
    cursor += slot.advance;
    index += 1;
  }
  return slots.length;
}

interface LaidOutSlot {
  readonly slot: StripSlot;
  readonly centreX: number;
}

/**
 * Lay the measured widths out in the provisional order and return each item's
 * viewport centre. Deliberately NOT read from live DOM rects: those are mid
 * spring animation, and feeding an animating rect back into the decision that
 * drives the animation is the feedback loop this model exists to remove.
 */
function layOutProvisional(
  geometry: StripDragGeometry,
  contentOriginX: number,
  targetIndex: number,
): ReadonlyArray<LaidOutSlot> {
  const ordered = provisionalStripOrder(
    geometry.slots,
    geometry.sourceIndex,
    targetIndex,
  );
  const originOffset = geometry.slots[0]?.contentLeft ?? 0;
  const laidOut: LaidOutSlot[] = [];
  let cursor = contentOriginX + originOffset;
  for (const slot of ordered) {
    laidOut.push({ slot, centreX: cursor + slot.width / 2 });
    cursor += slot.advance;
  }
  return laidOut;
}

function draggedCentreX(geometry: StripDragGeometry, pointerX: number): number {
  const sourceWidth = geometry.slots[geometry.sourceIndex]?.width ?? 0;
  // Deliberately unclamped. Clamping here would decouple the dragged centre
  // from the pointer at both ends of the strip, sliding the merge band out from
  // under the pointer. The overlay clamps for presentation; the model must not.
  return pointerX - geometry.grabOffsetX + sourceWidth / 2;
}

function previousTargetIndex(
  geometry: StripDragGeometry,
  previous: StripDragState | null,
): number {
  return previous === null ? geometry.sourceIndex : previous.targetIndex;
}

/**
 * Settle the insertion index by crossing one boundary at a time. Iterated, so a
 * single fast frame spanning three tabs lands three deterministic single
 * boundary swaps rather than one jump - which is what keeps every displaced
 * neighbour animating instead of teleporting.
 */
function settleTargetIndex(
  geometry: StripDragGeometry,
  contentOriginX: number,
  startIndex: number,
  centre: number,
): number {
  const lastIndex = geometry.slots.length - 1;
  let index = Math.min(Math.max(startIndex, 0), Math.max(lastIndex, 0));
  // Bounded by the slot count: each iteration moves the index one step and the
  // thresholds are monotone, so this cannot cycle.
  for (let guard = 0; guard <= geometry.slots.length; guard += 1) {
    const laidOut = layOutProvisional(geometry, contentOriginX, index);
    if (index + 1 < laidOut.length) {
      const right = laidOut[index + 1];
      if (
        centre >
        right.centreX + bandPxFor(right.slot.width, geometry.mergeBandPx)
      ) {
        index += 1;
        continue;
      }
    }
    if (index - 1 >= 0) {
      const left = laidOut[index - 1];
      if (
        centre <
        left.centreX - bandPxFor(left.slot.width, geometry.mergeBandPx)
      ) {
        index -= 1;
        continue;
      }
    }
    return index;
  }
  return index;
}

/**
 * The mergeable neighbour whose centre the dragged tab is currently sitting on,
 * or null. Both neighbours are candidates; the nearer one wins when the strip is
 * narrow enough for the bands to overlap.
 */
function mergeCandidate(
  geometry: StripDragGeometry,
  contentOriginX: number,
  targetIndex: number,
  centre: number,
): StripSlot | null {
  const laidOut = layOutProvisional(geometry, contentOriginX, targetIndex);
  const neighbours = [targetIndex - 1, targetIndex + 1]
    .filter((index) => index >= 0 && index < laidOut.length)
    .map((index) => laidOut[index]);
  let best: StripSlot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const neighbour of neighbours) {
    if (!neighbour.slot.isMergeTarget) continue;
    const distance = Math.abs(centre - neighbour.centreX);
    if (
      distance <= bandPxFor(neighbour.slot.width, geometry.mergeBandPx) &&
      distance < bestDistance
    ) {
      best = neighbour.slot;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The whole gesture in one pure step. Same inputs always give the same output,
 * which is what makes the monotonicity and hysteresis properties testable
 * without a browser.
 */
export function resolveStripDragState(
  input: ResolveStripDragInput,
): StripDragState {
  const { geometry, contentOriginX, pointerX, previous, nowMs } = input;
  if (geometry.slots.length === 0) {
    return { kind: "reorder", targetIndex: 0 };
  }
  const centre = draggedCentreX(geometry, pointerX);
  const targetIndex = settleTargetIndex(
    geometry,
    contentOriginX,
    previousTargetIndex(geometry, previous),
    centre,
  );
  const candidate = mergeCandidate(
    geometry,
    contentOriginX,
    targetIndex,
    centre,
  );
  if (candidate === null) {
    // Left the band: a preview drops back to plain reorder at this very pointer
    // position, so the transition is continuous rather than a jump.
    return { kind: "reorder", targetIndex };
  }
  if (previous !== null && previous.kind !== "reorder") {
    if (previous.targetItemId === candidate.itemId) {
      // A preview is sticky while the dragged tab stays on the target - only
      // leaving the band ends it, never further movement inside it.
      if (previous.kind === "merge-preview") {
        return {
          kind: "merge-preview",
          targetIndex,
          targetItemId: candidate.itemId,
        };
      }
      const travelled = Math.abs(pointerX - previous.armedAtPointerX);
      if (travelled <= MERGE_STILLNESS_PX) {
        return nowMs - previous.armedAtMs >= MERGE_DWELL_MS
          ? {
              kind: "merge-preview",
              targetIndex,
              targetItemId: candidate.itemId,
            }
          : { ...previous, targetIndex };
      }
      // Moved too far to still be dwelling: re-anchor rather than latch, so
      // drifting never accumulates its way to a merge but stopping still arms.
      return {
        kind: "merge-armed",
        targetIndex,
        targetItemId: candidate.itemId,
        armedAtMs: nowMs,
        armedAtPointerX: pointerX,
      };
    }
  }
  return {
    kind: "merge-armed",
    targetIndex,
    targetItemId: candidate.itemId,
    armedAtMs: nowMs,
    armedAtPointerX: pointerX,
  };
}

/**
 * Largest disagreement, in px, between the laid-out reconstruction of the
 * ORIGINAL order and what was actually measured. Zero for a contiguous strip.
 * The model's correctness rests on this staying small, so it is checked rather
 * than assumed.
 */
export function reconstructionErrorPx(slots: ReadonlyArray<StripSlot>): number {
  const origin = slots[0]?.contentLeft ?? 0;
  let cursor = origin;
  let worst = 0;
  for (const slot of slots) {
    worst = Math.max(worst, Math.abs(cursor - slot.contentLeft));
    cursor += slot.advance;
  }
  return worst;
}

/**
 * Re-measure after the strip's item list changed mid-drag (agent activity opens
 * tabs). The source is tracked by id, not index, because everything around it
 * may have shifted. Returns null when the dragged item is gone, which the caller
 * turns into a cancelled drag.
 */
export function remapGeometryToSlots(
  geometry: StripDragGeometry,
  slots: ReadonlyArray<StripSlot>,
): StripDragGeometry | null {
  if (
    geometry.sourceIndex < 0 ||
    geometry.sourceIndex >= geometry.slots.length
  ) {
    return null;
  }
  const sourceItemId = geometry.slots[geometry.sourceIndex].itemId;
  const sourceIndex = slots.findIndex((slot) => slot.itemId === sourceItemId);
  if (sourceIndex < 0) return null;
  return { ...geometry, slots, sourceIndex };
}
