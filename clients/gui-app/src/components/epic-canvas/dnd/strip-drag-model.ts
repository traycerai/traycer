/**
 * Geometry model for header-strip tab dragging.
 *
 * The model is one-dimensional: every position and extent is measured along
 * the strip's main axis (x for a horizontal strip, y for a vertical one). The
 * caller maps the viewport onto that axis (see `strip-axis.ts`); nothing here
 * knows which axis it is.
 *
 * Chrome does not hit-test droppables to decide a reorder, and neither does
 * this: the insertion index is a pure function of the pointer's position
 * against item extents measured once at drag start. That is what makes the
 * result stable. Resolving against live droppables re-enters the loop it is driving - the
 * provisional order moves a tab under the pointer, which changes the hit, which
 * changes the provisional order - and the strip oscillates.
 *
 * Two properties are load-bearing and both fall out of the swap rule rather
 * than being tuned in:
 *
 * - **Monotonicity.** A monotone pointer sweep yields a monotone index.
 * - **Hysteresis.** After a swap the neighbour's centre has moved, so reversing
 *   requires re-crossing `sourceExtent` - see `swapHysteresisPx`. Note this is
 *   the SOURCE's extent, not the mean of the pair: the two coincide only for
 *   equal-extent items, and a split group is one strip item of its own extent.
 *
 * Merge (pair-into-split) and reorder divide a hovered neighbour at its centre.
 * The approaching half is the merge target; crossing the midpoint starts the
 * reorder. This gives both actions a large, deterministic target without
 * requiring pixel-perfect placement, and it makes the state a pure function of
 * position: nothing is ever held in time, so there is no dwell to explain and
 * no timer to keep alive.
 *
 * Both zones are resolved against the DRAGGED TAB'S CENTRE
 * (`pointer - grabOffset + extent/2`), never against the raw pointer - the same
 * reference Chrome uses for its swap rule. The user watches the tab in their
 * hand, not the invisible pointer, and the two can disagree by up to a full
 * tab extent: grab a tab by its trailing edge and drag toward its leading side,
 * and the tab visibly sits ON TOP of the neighbour while the pointer is still
 * back over the source slot. Pointer-resolved zones make that gesture a dead
 * zone - the tab overlaps the target, nothing highlights, nothing swaps -
 * which reads as the drag simply not working. The centre moves 1:1 with the
 * pointer, so monotonicity and hysteresis are unaffected by the choice; what
 * changes is that every boundary sits where the visible tab says it is.
 */

export interface StripSlot {
  readonly itemId: string;
  readonly extent: number;
  /**
   * Start edge in the strip's CONTENT box, so scrolling cannot invalidate it.
   */
  readonly contentStart: number;
  /**
   * Distance from this slot's start edge to the next slot's, measured rather
   * than assumed. Prefix-summing raw extents would silently bias every centre
   * by an accumulating amount if any wrapper carries margin, padding or a
   * border - worst at the end of the strip, and invisible to a unit test
   * that generates its own contiguous geometry.
   */
  readonly advance: number;
  /**
   * Whether this item can be merged into. A split group cannot: the pair target
   * carries a single `TabRef` and a two-ref item has no unambiguous one.
   */
  readonly isMergeTarget: boolean;
  /**
   * The section a sectioned strip holds the item in, `null` for a strip with
   * none. A drag moves an item among the slots of its own lane only.
   */
  readonly lane: string | null;
}

export interface StripDragGeometry {
  readonly slots: ReadonlyArray<StripSlot>;
  readonly sourceIndex: number;
  /**
   * Press position minus the source's start edge, held for the life of the
   * gesture.
   */
  readonly grabOffset: number;
  /**
   * The source tab's viewport start edge at drag start. dnd-kit positions the
   * overlay from this rect, so every overlay calculation must be expressed
   * against it -
   * never against a live rect, which tracks the placeholder as it slides.
   */
  readonly sourceInitialStart: number;
  readonly sourceExtent: number;
  readonly bandStart: number;
  readonly bandEnd: number;
}

/**
 * The pair side the DRAGGED tab would take on a merge: the side it approaches
 * from. `left` is the start half (left horizontally, top vertically) and
 * `right` the end half. Dragging toward the end onto a neighbour hovers its
 * start half, so the dragged tab becomes the LEFT member; toward the start is
 * the mirror. Preview and
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
   * Viewport position of the strip's content origin along the main axis,
   * re-read every frame as the strip's start edge minus its scroll offset. The
   * strip scrolls mid-drag - by wheel and by dnd-kit autoScroll - and a cached
   * origin desyncs every
   * neighbour centre with no recovery.
   */
  readonly contentOrigin: number;
  readonly pointer: number;
  /**
   * Carries only the settled `targetIndex` between frames - see the swap rule.
   */
  readonly previous: StripDragState | null;
}

/**
 * Distance the pointer must travel back before a just-made swap reverses.
 * Both crossings use the approached tab's midpoint. After the swap that tab
 * occupies the source slot, so the midpoint shift - and therefore
 * hysteresis - is exactly the dragged source extent, independent of unequal
 * neighbour extents.
 */
export function swapHysteresisPx(sourceExtent: number): number {
  return sourceExtent;
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
 * Where the dragged tab's overlay should start, in VIEWPORT coordinates along
 * the main axis.
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
 *   pins the overlay at the source's original end edge partway through a
 *   drag. On the second-to-last tab that pinned value coincides with the
 *   correct bound, so the bug is invisible on exactly one strip position.
 */
export function overlayStartForPointer(input: {
  readonly pointer: number;
  readonly grabOffset: number;
  readonly sourceExtent: number;
  readonly stripStart: number;
  readonly stripEnd: number;
}): number {
  const desired = input.pointer - input.grabOffset;
  const maxStart = Math.max(
    input.stripStart,
    input.stripEnd - input.sourceExtent,
  );
  return Math.min(Math.max(desired, input.stripStart), maxStart);
}

/**
 * Per-item main-axis displacement, in px, for a strip rendering a provisional
 * order.
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

  // Natural start of each slot, then its start in the provisional order.
  const naturalStart = new Map<string, number>();
  let cursor = 0;
  for (const slot of slots) {
    naturalStart.set(slot.itemId, cursor);
    cursor += slot.advance;
  }
  const ordered = provisionalStripOrder(slots, sourceIndex, targetIndex);
  cursor = 0;
  for (const slot of ordered) {
    offsets.set(slot.itemId, cursor - (naturalStart.get(slot.itemId) ?? 0));
    cursor += slot.advance;
  }
  return offsets;
}

/**
 * Offsets for a strip the dragged item is being INSERTED into from another
 * group: it has no slot here, so everything from `insertIndex` onwards opens a
 * gap of `insertExtent`.
 */
export function insertionOffsetsFor(
  slots: ReadonlyArray<StripSlot>,
  insertIndex: number,
  insertExtent: number,
): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  slots.forEach((slot, index) => {
    offsets.set(slot.itemId, index >= insertIndex ? insertExtent : 0);
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
  contentOrigin: number,
  pointer: number,
): number {
  let cursor = contentOrigin + (slots[0]?.contentStart ?? 0);
  let index = 0;
  for (const slot of slots) {
    if (pointer < cursor + slot.extent / 2) return index;
    cursor += slot.advance;
    index += 1;
  }
  return slots.length;
}

interface LaidOutSlot {
  readonly slot: StripSlot;
  readonly centre: number;
}

/**
 * Lay the measured extents out in the provisional order and return each item's
 * viewport centre. Deliberately NOT read from live DOM rects: those are mid
 * spring animation, and feeding an animating rect back into the decision that
 * drives the animation is the feedback loop this model exists to remove.
 */
function layOutProvisional(
  geometry: StripDragGeometry,
  contentOrigin: number,
  targetIndex: number,
): ReadonlyArray<LaidOutSlot> {
  const ordered = provisionalStripOrder(
    geometry.slots,
    geometry.sourceIndex,
    targetIndex,
  );
  const originOffset = geometry.slots[0]?.contentStart ?? 0;
  const laidOut: LaidOutSlot[] = [];
  let cursor = contentOrigin + originOffset;
  for (const slot of ordered) {
    laidOut.push({ slot, centre: cursor + slot.extent / 2 });
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
  contentOrigin: number,
  startIndex: number,
  centre: number,
): number {
  const lastIndex = geometry.slots.length - 1;
  let index = Math.min(Math.max(startIndex, 0), Math.max(lastIndex, 0));
  // Bounded by the slot count: each iteration moves the index one step and the
  // thresholds are monotone, so this cannot cycle.
  for (let guard = 0; guard <= geometry.slots.length; guard += 1) {
    const laidOut = layOutProvisional(geometry, contentOrigin, index);
    if (index + 1 < laidOut.length) {
      const right = laidOut[index + 1];
      if (centre > right.centre) {
        index += 1;
        continue;
      }
    }
    if (index - 1 >= 0) {
      const left = laidOut[index - 1];
      if (centre < left.centre) {
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
 * swap, the passed tab sits a full `sourceExtent` behind the dragged centre,
 * so it can only re-arm when the centre genuinely re-enters its half (a
 * narrow tab still overlapping a wide neighbour it just passed, or the user
 * reversing onto it). Filtering by net travel instead re-created the dead
 * zone the module doc forbids: reverse after a swap and the tab visibly sat
 * on the neighbour's half with nothing highlighted. Both neighbours are
 * candidates; the nearer one wins on a strip narrow enough for both slots to
 * contain the centre. A candidate AHEAD of the dragged tab is approached from
 * its start (the dragged tab would take the pair's left side); one behind is
 * the mirror.
 */
function mergeCandidate(
  geometry: StripDragGeometry,
  contentOrigin: number,
  targetIndex: number,
  centre: number,
): MergeCandidateResult | null {
  const laidOut = layOutProvisional(geometry, contentOrigin, targetIndex);
  const candidateIndices = [targetIndex - 1, targetIndex + 1];
  let best: MergeCandidateResult | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of candidateIndices) {
    if (index < 0 || index >= laidOut.length) continue;
    const neighbour = laidOut[index];
    if (!neighbour.slot.isMergeTarget) continue;
    const distance = Math.abs(centre - neighbour.centre);
    if (distance <= neighbour.slot.extent / 2 && distance < bestDistance) {
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
  const { geometry, contentOrigin, pointer, previous } = input;
  if (geometry.slots.length === 0) {
    return { kind: "reorder", targetIndex: 0 };
  }
  // The overlay's centre: where the user sees the tab, offset from the pointer
  // by the constant grab offset. See the module doc for why zones must follow
  // this and not the raw pointer.
  const draggedCentre =
    pointer - geometry.grabOffset + geometry.sourceExtent / 2;
  const targetIndex = settleTargetIndex(
    geometry,
    contentOrigin,
    previousTargetIndex(geometry, previous),
    draggedCentre,
  );
  const candidate = mergeCandidate(
    geometry,
    contentOrigin,
    targetIndex,
    draggedCentre,
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
  const origin = slots[0]?.contentStart ?? 0;
  let cursor = origin;
  let worst = 0;
  for (const slot of slots) {
    worst = Math.max(worst, Math.abs(cursor - slot.contentStart));
    cursor += slot.advance;
  }
  return worst;
}

/**
 * The slots of the source item's own lane, each one's `advance` measured to
 * the next slot of that lane. A lane is one contiguous run of the strip, so
 * the model reorders it as a strip of its own; a source in no lane (or a strip
 * with none) leaves the slots as measured.
 */
export function laneSlotsOf(
  slots: ReadonlyArray<StripSlot>,
  sourceItemId: string,
): ReadonlyArray<StripSlot> {
  const lane = slots.find((slot) => slot.itemId === sourceItemId)?.lane ?? null;
  if (lane === null) return slots;
  const inLane = slots.filter((slot) => slot.lane === lane);
  return inLane.map((slot, index) => ({
    ...slot,
    advance:
      index + 1 < inLane.length
        ? inLane[index + 1].contentStart - slot.contentStart
        : slot.extent,
  }));
}

/**
 * The viewport range, along the main axis, of the source's lane, which the
 * dragged item never leaves; `null` when the source is in no lane.
 */
export function laneBoundsOf(
  geometry: StripDragGeometry,
  contentOrigin: number,
): { readonly start: number; readonly end: number } | null {
  const first = geometry.slots.at(0);
  const last = geometry.slots.at(-1);
  const source = geometry.slots.at(geometry.sourceIndex);
  if (
    first === undefined ||
    last === undefined ||
    source === undefined ||
    source.lane === null
  ) {
    return null;
  }
  return {
    start: contentOrigin + first.contentStart,
    end: contentOrigin + last.contentStart + last.extent,
  };
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
  const laneSlots = laneSlotsOf(slots, sourceItemId);
  const sourceIndex = laneSlots.findIndex(
    (slot) => slot.itemId === sourceItemId,
  );
  if (sourceIndex < 0) return null;
  return { ...geometry, slots: laneSlots, sourceIndex };
}
