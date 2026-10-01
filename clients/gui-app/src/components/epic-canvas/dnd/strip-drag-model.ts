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
 * In a strip with tab groups the neighbours' centres the swap rule crosses are
 * the ones the drag draws (`strip-group-layout.ts`): a group's header and block
 * padding are laid out where the provisional order puts them, not carried in a
 * slot's `advance`, so a tab swaps with a neighbour when it reaches the
 * neighbour as drawn. The layout depends on the group the dragged tab is in,
 * and that on the index, so each frame settles the two against each other from
 * the previous frame's group.
 *
 * A split (pair-into-split) is deliberate, a move is the default. The dragged
 * centre has to stay in the MIDDLE HALF of a mergeable neighbour for
 * `SPLIT_HOLD_MS` before the state becomes a merge; anywhere else, and in the
 * middle before the hold completes, it is a reorder. The clock is an input
 * (`now`), carried between frames in the previous state's `hold`, so the model
 * stays a pure function: the caller owns the timer that asks again when the
 * pointer holds still.
 *
 * A reorder also decides group membership, by position: the group whose block
 * (or chip and members) the dragged centre is inside, when that group is one of
 * the insertion point's neighbours, or the group both neighbours share. A group
 * with no tabs drawn (collapsed) has no neighbours to be one of, so the centre
 * inside its header is enough.
 *
 * Both zones and the membership are resolved against the DRAGGED TAB'S CENTRE
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
import {
  chromeLayoutFor,
  laneGroupsOf,
  type StripLayout,
} from "@/components/epic-canvas/dnd/strip-group-layout";

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
  /** The tab group the item is in, `null` for an ungrouped item. */
  readonly groupId: string | null;
}

/**
 * Where a tab group is drawn, in the strip's CONTENT box like a slot's start:
 * its block in the sidebar, its chip (margins included) and tabs in the top
 * bar. A group drawn in several runs (the Activity view's sections) has an
 * extent per run, each in its own lane.
 */
export interface StripGroupExtent {
  readonly groupId: string;
  readonly start: number;
  readonly end: number;
  /** The section the extent is drawn in; `null` for a strip with none. */
  readonly lane: string | null;
  /** The gap between the group's own tabs. */
  readonly rowGap: number;
  /**
   * Whether the group's membership is not this drag's to change, because the
   * dragged tab's menu does not offer the group either (an organization's group
   * for a tab the organization does not keep, or the other way round): the
   * dragged tab does not join it and, when in it, does not leave it.
   */
  readonly locked: boolean;
}

export interface StripDragGeometry {
  readonly slots: ReadonlyArray<StripSlot>;
  readonly groups: ReadonlyArray<StripGroupExtent>;
  /** The gap between neighbouring items or groups of the strip. */
  readonly runGap: number;
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

/**
 * How long the dragged centre has been in the middle half of `itemId`, from
 * the `now` of the frame it entered it.
 */
export interface StripHold {
  readonly itemId: string;
  readonly since: number;
}

export type StripDragState =
  | {
      readonly kind: "reorder";
      readonly targetIndex: number;
      /** The group the drop lands in; `null` outside every group. */
      readonly groupId: string | null;
      /** Whether that is a group the dragged item is not in now. */
      readonly joinsGroup: boolean;
      /** The middle-half hold under way; it arms a split at `SPLIT_HOLD_MS`. */
      readonly hold: StripHold | null;
    }
  | {
      readonly kind: "merge";
      readonly targetIndex: number;
      readonly targetItemId: string;
      readonly targetSide: MergeSide;
      readonly hold: StripHold;
    };

/** How long the dragged centre rests in a task's middle half to arm a split. */
export const SPLIT_HOLD_MS = 350;

/** The middle half of a task is within this fraction of its extent of its centre. */
const SPLIT_ZONE_RADIUS = 0.25;

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
  /** The frame's time, in ms; only differences between frames are read. */
  readonly now: number;
  /** False for a keyboard drag, which never splits. */
  readonly canSplit: boolean;
  /**
   * Carries the settled `targetIndex` between frames - see the swap rule - and
   * the hold's start.
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
 * The strip laid out with the dragged slot moved to `targetIndex` and put in
 * `groupId` (`null` for none): every slot's displacement, and where each group's
 * chrome is. A strip with no groups to lay out around is displaced by the
 * slots' own advance, as it always was, and moves no group.
 */
export function stripLayoutFor(
  geometry: StripDragGeometry,
  targetIndex: number,
  groupId: string | null,
): StripLayout {
  return laneGroupsOf(geometry).length === 0
    ? { offsets: stripOffsetsFor(geometry, targetIndex), groups: [] }
    : chromeLayoutFor(geometry, targetIndex, groupId);
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
 * Lay the measured extents out in the provisional order, with the dragged tab
 * in `groupId`, and return each item's viewport centre. Deliberately NOT read
 * from live DOM rects: those are mid spring animation, and feeding an animating
 * rect back into the decision that drives the animation is the feedback loop
 * this model exists to remove. In a strip with groups the centres are the ones
 * the drag draws, which place each group's chrome where it now is.
 */
function layOutProvisional(
  geometry: StripDragGeometry,
  contentOrigin: number,
  placement: { readonly targetIndex: number; readonly groupId: string | null },
): ReadonlyArray<LaidOutSlot> {
  const { targetIndex, groupId } = placement;
  const ordered = provisionalStripOrder(
    geometry.slots,
    geometry.sourceIndex,
    targetIndex,
  );
  if (laneGroupsOf(geometry).length > 0) {
    const { offsets } = chromeLayoutFor(geometry, targetIndex, groupId);
    return ordered.map((slot) => ({
      slot,
      centre:
        contentOrigin +
        slot.contentStart +
        (offsets.get(slot.itemId) ?? 0) +
        slot.extent / 2,
    }));
  }
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

/** The groups whose membership the drag does not change. */
function lockedGroupIds(geometry: StripDragGeometry): ReadonlySet<string> {
  return new Set(
    geometry.groups.filter((group) => group.locked).map((g) => g.groupId),
  );
}

/**
 * How many slots crossing the neighbour on `step`'s side takes: one, or the
 * whole run of a locked group the dragged tab is not in, which is crossed as
 * one unit when the centre passes the run's own centre, so the dragged tab is
 * never left inside it. 0 when the centre has not passed.
 */
function slotsCrossed(
  laidOut: ReadonlyArray<LaidOutSlot>,
  index: number,
  step: 1 | -1,
  pass: { readonly locked: ReadonlySet<string>; readonly centre: number },
): number {
  const { locked, centre } = pass;
  if (index + step < 0 || index + step >= laidOut.length) return 0;
  const first = laidOut[index + step];
  const groupId = first.slot.groupId;
  const run =
    groupId !== null &&
    locked.has(groupId) &&
    groupId !== laidOut[index].slot.groupId
      ? runLength(laidOut, index + step, step, groupId)
      : 1;
  const runCentre =
    run === 1 ? first.centre : centreOfRun(first, laidOut[index + step * run]);
  const passed = step === 1 ? centre > runCentre : centre < runCentre;
  return passed ? run : 0;
}

/** The centre of the span from one laid-out slot to another, either order. */
function centreOfRun(first: LaidOutSlot, last: LaidOutSlot): number {
  const edges = [first, last].flatMap((entry) => [
    entry.centre - entry.slot.extent / 2,
    entry.centre + entry.slot.extent / 2,
  ]);
  return (Math.min(...edges) + Math.max(...edges)) / 2;
}

/** The slots from `from` going `step` that share `groupId`. */
function runLength(
  laidOut: ReadonlyArray<LaidOutSlot>,
  from: number,
  step: 1 | -1,
  groupId: string,
): number {
  let count = 0;
  while (laidOut[from + step * count]?.slot.groupId === groupId) count += 1;
  return count;
}

/**
 * The indices the dragged tab can settle at: all of them, or a locked group's
 * own run when it is one of that group's tabs, which reorders within the group
 * and never leaves it.
 */
function movableRange(
  geometry: StripDragGeometry,
  locked: ReadonlySet<string>,
): { readonly low: number; readonly high: number } {
  const { slots, sourceIndex } = geometry;
  const groupId = slots[sourceIndex]?.groupId ?? null;
  if (groupId === null || !locked.has(groupId)) {
    return { low: 0, high: Math.max(slots.length - 1, 0) };
  }
  let low = sourceIndex;
  while (slots[low - 1]?.groupId === groupId) low -= 1;
  let high = sourceIndex;
  while (slots[high + 1]?.groupId === groupId) high += 1;
  return { low, high };
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
  dragged: { readonly centre: number; readonly groupId: string | null },
): number {
  const { centre, groupId } = dragged;
  const locked = lockedGroupIds(geometry);
  const { low, high } = movableRange(geometry, locked);
  let index = Math.min(Math.max(startIndex, low), high);
  // Bounded by the slot count: each iteration moves the index at least one step
  // and the thresholds are monotone, so this cannot cycle.
  for (let guard = 0; guard <= geometry.slots.length; guard += 1) {
    const laidOut = layOutProvisional(geometry, contentOrigin, {
      targetIndex: index,
      groupId,
    });
    const forward = slotsCrossed(laidOut, index, 1, { locked, centre });
    if (forward > 0 && index + forward <= high) {
      index += forward;
      continue;
    }
    const back = slotsCrossed(laidOut, index, -1, { locked, centre });
    if (back > 0 && index - back >= low) {
      index -= back;
      continue;
    }
    return index;
  }
  return index;
}

interface SplitCandidateResult {
  readonly slot: StripSlot;
  readonly side: MergeSide;
}

/**
 * The mergeable neighbour whose MIDDLE HALF the dragged tab's centre is
 * currently inside, or null. Candidacy is purely positional - centre within
 * `SPLIT_ZONE_RADIUS` of a neighbour's provisional centre - with NO
 * travel-direction filter: after a swap, the passed tab sits a full
 * `sourceExtent` behind the dragged centre, so it can only re-arm when the
 * centre genuinely re-enters its middle (a narrow tab still overlapping a wide
 * neighbour it just passed, or the user reversing onto it). Filtering by net
 * travel instead re-created the dead zone the module doc forbids: reverse after
 * a swap and the tab visibly sat on the neighbour with nothing highlighted.
 * Both neighbours are candidates; the nearer one wins on a strip narrow enough
 * for both middles to contain the centre. A candidate AHEAD of the dragged tab
 * is approached from its start (the dragged tab would take the pair's left
 * side); one behind is the mirror.
 */
function splitCandidate(
  laidOut: ReadonlyArray<LaidOutSlot>,
  targetIndex: number,
  centre: number,
): SplitCandidateResult | null {
  const candidateIndices = [targetIndex - 1, targetIndex + 1];
  let best: SplitCandidateResult | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of candidateIndices) {
    if (index < 0 || index >= laidOut.length) continue;
    const neighbour = laidOut[index];
    if (!neighbour.slot.isMergeTarget) continue;
    const distance = Math.abs(centre - neighbour.centre);
    if (
      distance <= neighbour.slot.extent * SPLIT_ZONE_RADIUS &&
      distance < bestDistance
    ) {
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
 * The group whose block, or chip and tabs, the dragged centre is inside: what
 * is drawn on screen, which does not move as the tabs slide. Only the dragged
 * tab's own section counts; the pointer can stray past it, but the tab cannot.
 */
function groupAt(
  geometry: StripDragGeometry,
  contentOrigin: number,
  centre: number,
): string | null {
  return (
    laneGroupsOf(geometry).find(
      (group) =>
        centre >= contentOrigin + group.start &&
        centre < contentOrigin + group.end,
    )?.groupId ?? null
  );
}

/**
 * The group a drop at `targetIndex` lands in, `inside` being the group the
 * dragged centre is inside. Position decides: between two tabs of one group it
 * is that group; at the edge of a group it is `inside` when that group is a
 * neighbour of the drop, so the side of the boundary the centre is on decides.
 * A collapsed group draws no tab to be a neighbour of, so its header takes the
 * drop alone. A locked group is the exception to all of it: its tab keeps its
 * group wherever it is dropped, and nothing else joins it.
 */
function dropGroupId(
  geometry: StripDragGeometry,
  laidOut: ReadonlyArray<LaidOutSlot>,
  targetIndex: number,
  inside: string | null,
): string | null {
  const locked = lockedGroupIds(geometry);
  const sourceGroupId = geometry.slots[geometry.sourceIndex]?.groupId ?? null;
  if (sourceGroupId !== null && locked.has(sourceGroupId)) return sourceGroupId;
  const before = laidOut[targetIndex - 1]?.slot.groupId ?? null;
  const after = laidOut[targetIndex + 1]?.slot.groupId ?? null;
  let groupId: string | null = null;
  if (before !== null && before === after) groupId = before;
  else if (inside === before || inside === after) groupId = inside;
  else if (!geometry.slots.some((slot) => slot.groupId === inside)) {
    groupId = inside;
  }
  return groupId !== null && locked.has(groupId) ? null : groupId;
}

/**
 * The hold the next frame carries: the one under way when the centre is still
 * in the same task's middle, else a new one starting now, else none.
 */
function nextHold(
  candidate: SplitCandidateResult | null,
  previous: StripDragState | null,
  now: number,
): StripHold | null {
  if (candidate === null) return null;
  const itemId = candidate.slot.itemId;
  return previous?.hold?.itemId === itemId
    ? previous.hold
    : { itemId, since: now };
}

/** How often a frame settles the index and the dragged tab's group against each other. */
const SETTLE_PASSES = 3;

/**
 * The insertion index and the group the drop lands in, and the strip laid out
 * for them. Each depends on the other - the group the dragged tab is in moves
 * the neighbours it swaps with, and the index decides which group is beside it -
 * so the group of the previous frame (the source's own to begin with) starts the
 * index settling, the group is read off the result, and the two repeat until
 * they agree. Crossing a neighbour needs the dragged centre past where that
 * neighbour is drawn, and a group's chrome only ever moves it away from the
 * centre that has just crossed, so the pass settles in a step or two.
 */
function settleDrop(input: {
  readonly geometry: StripDragGeometry;
  readonly contentOrigin: number;
  readonly previous: StripDragState | null;
  readonly centre: number;
}): {
  readonly targetIndex: number;
  readonly groupId: string | null;
  readonly laidOut: ReadonlyArray<LaidOutSlot>;
} {
  const { geometry, contentOrigin, previous, centre } = input;
  const sourceGroupId = geometry.slots[geometry.sourceIndex]?.groupId ?? null;
  let groupId = previous?.kind === "reorder" ? previous.groupId : sourceGroupId;
  let targetIndex = previousTargetIndex(geometry, previous);
  for (let pass = 0; pass < SETTLE_PASSES; pass += 1) {
    targetIndex = settleTargetIndex(geometry, contentOrigin, targetIndex, {
      centre,
      groupId,
    });
    const laidOut = layOutProvisional(geometry, contentOrigin, {
      targetIndex,
      groupId,
    });
    const settled = dropGroupId(
      geometry,
      laidOut,
      targetIndex,
      groupAt(geometry, contentOrigin, centre),
    );
    if (settled === groupId) return { targetIndex, groupId, laidOut };
    groupId = settled;
  }
  return {
    targetIndex,
    groupId,
    laidOut: layOutProvisional(geometry, contentOrigin, {
      targetIndex,
      groupId,
    }),
  };
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
    return {
      kind: "reorder",
      targetIndex: 0,
      groupId: null,
      joinsGroup: false,
      hold: null,
    };
  }
  // The overlay's centre: where the user sees the tab, offset from the pointer
  // by the constant grab offset. See the module doc for why zones must follow
  // this and not the raw pointer.
  const draggedCentre =
    pointer - geometry.grabOffset + geometry.sourceExtent / 2;
  const { targetIndex, groupId, laidOut } = settleDrop({
    geometry,
    contentOrigin,
    previous,
    centre: draggedCentre,
  });
  const candidate = input.canSplit
    ? splitCandidate(laidOut, targetIndex, draggedCentre)
    : null;
  const hold = nextHold(candidate, previous, input.now);
  if (
    candidate !== null &&
    hold !== null &&
    input.now - hold.since >= SPLIT_HOLD_MS
  ) {
    return {
      kind: "merge",
      targetIndex,
      targetItemId: candidate.slot.itemId,
      targetSide: candidate.side,
      hold,
    };
  }
  // Off every mergeable middle, or not held there long enough: a plain reorder
  // at this very pointer position, so the merge-to-reorder transition is
  // continuous rather than a jump.
  const sourceGroupId = geometry.slots[geometry.sourceIndex]?.groupId ?? null;
  return {
    kind: "reorder",
    targetIndex,
    groupId,
    joinsGroup: groupId !== null && groupId !== sourceGroupId,
    hold,
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
  groups: ReadonlyArray<StripGroupExtent>,
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
  return { ...geometry, slots: laneSlots, groups, sourceIndex };
}
