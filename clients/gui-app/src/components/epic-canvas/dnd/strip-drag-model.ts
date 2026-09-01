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
 *   requires re-crossing `sourceWidth` - see `swapHysteresisPx`. Note this is
 *   the SOURCE's width, not the mean of the pair: the two coincide only for
 *   equal-width items, and a split group is one strip item of its own width.
 *
 * Merge (pair-into-split) and reorder divide a hovered neighbour at its centre.
 * The approaching half is the merge target; crossing the midpoint starts the
 * reorder. This gives both actions a large, deterministic target without
 * requiring pixel-perfect placement, and it makes the state a pure function of
 * position: nothing is ever held in time, so there is no dwell to explain and
 * no timer to keep alive.
 *
 * Both zones are resolved against the DRAGGED TAB'S CENTRE
 * (`pointer - grabOffset + width/2`), never against the raw pointer - the same
 * reference Chrome uses for its swap rule. The user watches the tab in their
 * hand, not the invisible pointer, and the two can disagree by up to a full
 * tab width: grab a tab by its trailing edge and drag toward its leading side,
 * and the tab visibly sits ON TOP of the neighbour while the pointer is still
 * back over the source slot. Pointer-resolved zones make that gesture a dead
 * zone - the tab overlaps the target, nothing highlights, nothing swaps -
 * which reads as the drag simply not working. The centre moves 1:1 with the
 * pointer, so monotonicity and hysteresis are unaffected by the choice; what
 * changes is that every boundary sits where the visible tab says it is.
 */

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
  readonly stripTop: number;
  readonly stripBottom: number;
}

/**
 * The pair side the DRAGGED tab would take on a merge: the side it approaches
 * from. Dragging rightward onto a neighbour hovers its left half, so the
 * dragged tab becomes the LEFT member; leftward is the mirror. Preview and
 * commit both read this one field, so the highlighted half and the committed
 * pair order cannot disagree.
 */
export type MergeSide = "left" | "right";

export type StripDragState =
  | { readonly kind: "reorder"; readonly targetIndex: number }
  | {
      readonly kind: "merge";
      readonly targetIndex: number;
      readonly targetItemId: string;
      readonly targetSide: MergeSide;
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
  /** Carries only the settled `targetIndex` between frames - see the swap rule. */
  readonly previous: StripDragState | null;
}

/**
 * Distance the pointer must travel back before a just-made swap reverses.
 * Both crossings use the approached tab's midpoint. After the swap that tab
 * occupies the source slot, so the midpoint shift—and therefore hysteresis—is
 * exactly the dragged source width, independent of unequal neighbour widths.
 */
export function swapHysteresisPx(sourceWidth: number): number {
  return sourceWidth;
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
 * `targetIndex === null` means the dragged item is outside this strip. The
 * source strip deliberately keeps its natural layout: the source slot stays in
 * place as an origin placeholder until the drop commits elsewhere (tile strips
 * dim it; the header hides its tab entirely under the overlay).
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

  if (targetIndex === null) {
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
  centreX: number,
): number {
  const lastIndex = geometry.slots.length - 1;
  let index = Math.min(Math.max(startIndex, 0), Math.max(lastIndex, 0));
  // Bounded by the slot count: each iteration moves the index one step and the
  // thresholds are monotone, so this cannot cycle.
  for (let guard = 0; guard <= geometry.slots.length; guard += 1) {
    const laidOut = layOutProvisional(geometry, contentOriginX, index);
    if (index + 1 < laidOut.length) {
      const right = laidOut[index + 1];
      if (centreX > right.centreX) {
        index += 1;
        continue;
      }
    }
    if (index - 1 >= 0) {
      const left = laidOut[index - 1];
      if (centreX < left.centreX) {
        index -= 1;
        continue;
      }
    }
    return index;
  }
  return index;
}

interface MergeCandidateResult {
  readonly slot: StripSlot;
  readonly side: MergeSide;
}

/**
 * The mergeable neighbour whose slot the dragged tab's centre is currently
 * inside, or null. Candidacy is purely positional - centre inside a
 * neighbour's provisional slot - with NO travel-direction filter: after a
 * swap, the passed tab sits a full `sourceWidth` behind the dragged centre,
 * so it can only re-arm when the centre genuinely re-enters its half (a
 * narrow tab still overlapping a wide neighbour it just passed, or the user
 * reversing onto it). Filtering by net travel instead re-created the dead
 * zone the module doc forbids: reverse after a swap and the tab visibly sat
 * on the neighbour's half with nothing highlighted. Both neighbours are
 * candidates; the nearer one wins on a strip narrow enough for both slots to
 * contain the centre. A candidate AHEAD of the dragged tab is approached from
 * its left (the dragged tab would take the pair's left side); one behind is
 * the mirror.
 */
function mergeCandidate(
  geometry: StripDragGeometry,
  contentOriginX: number,
  targetIndex: number,
  centreX: number,
): MergeCandidateResult | null {
  const laidOut = layOutProvisional(geometry, contentOriginX, targetIndex);
  const candidateIndices = [targetIndex - 1, targetIndex + 1];
  let best: MergeCandidateResult | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of candidateIndices) {
    if (index < 0 || index >= laidOut.length) continue;
    const neighbour = laidOut[index];
    if (!neighbour.slot.isMergeTarget) continue;
    const distance = Math.abs(centreX - neighbour.centreX);
    if (distance <= neighbour.slot.width / 2 && distance < bestDistance) {
      best = {
        slot: neighbour.slot,
        side: index > targetIndex ? "left" : "right",
      };
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
  const { geometry, contentOriginX, pointerX, previous } = input;
  if (geometry.slots.length === 0) {
    return { kind: "reorder", targetIndex: 0 };
  }
  // The overlay's centre: where the user sees the tab, offset from the pointer
  // by the constant grab offset. See the module doc for why zones must follow
  // this and not the raw pointer.
  const draggedCentreX =
    pointerX - geometry.grabOffsetX + geometry.sourceWidth / 2;
  const targetIndex = settleTargetIndex(
    geometry,
    contentOriginX,
    previousTargetIndex(geometry, previous),
    draggedCentreX,
  );
  const candidate = mergeCandidate(
    geometry,
    contentOriginX,
    targetIndex,
    draggedCentreX,
  );
  if (candidate === null) {
    // Off every mergeable half: plain reorder at this very pointer position,
    // so the merge-to-reorder transition is continuous rather than a jump.
    return { kind: "reorder", targetIndex };
  }
  return {
    kind: "merge",
    targetIndex,
    targetItemId: candidate.slot.itemId,
    targetSide: candidate.side,
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
