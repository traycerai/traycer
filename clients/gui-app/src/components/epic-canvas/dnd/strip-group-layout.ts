/**
 * Where everything in a strip with tab groups sits while a tab is dragged
 * among them: the tabs, and the groups' own chrome (a block's header and
 * padding, a chip and its margins).
 *
 * Displacing tabs alone cannot be right in such a strip. A group's chrome is
 * not a slot, so its length sits in the `advance` of the slot before it and
 * travels with that slot, while the chrome itself never moves: a tab dragged in
 * from above slides over the header it should have carried along, and a block
 * that gains a tab keeps its old box under a row that now hangs out of it. So
 * the layout is recomputed as a whole - the order with the dragged tab moved
 * and its group changed, each group's chrome where its first and last tab now
 * are - and every tab, header, chip and block is displaced to its place in it.
 *
 * It is the strip as it would be drawn if the drop were committed, which is
 * what makes the preview honest, and with nothing moved it is the strip as it
 * is. A gap between two items that were neighbours already is taken as
 * measured; a new neighbour pair is built from the chrome the groups measured
 * (`lead` and `tail`) and the gaps between rows and between groups.
 *
 * The model reads the tabs' centres from this same layout to decide when a
 * neighbour swaps, so the gap the preview draws and the place a tab swaps at
 * cannot disagree. It imports this module, so this one takes the model's types
 * only.
 */
import type {
  StripDragGeometry,
  StripGroupExtent,
  StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

/** Where one group's block (or chip) is drawn now, relative to where it is. */
export interface StripGroupPlacement {
  readonly groupId: string;
  readonly lane: string | null;
  /** How far the group's start moved, which its header or chip moves with. */
  readonly offset: number;
  /** How much longer the group is drawn than it is laid out; negative when shorter. */
  readonly grow: number;
  /** False once the group has no tab left, so nothing of it is drawn. */
  readonly visible: boolean;
}

export interface StripLayout {
  /** Each slot's displacement. */
  readonly offsets: ReadonlyMap<string, number>;
  readonly groups: ReadonlyArray<StripGroupPlacement>;
}

/** A tab, or a group drawn with none of its tabs (a collapsed one), in the strip's order. */
interface Piece {
  readonly slot: StripSlot | null;
  readonly group: StripGroupExtent | null;
  readonly start: number;
  readonly end: number;
}

/** The chrome a group draws before its first tab and after its last, as measured. */
interface Chrome {
  readonly lead: number;
  readonly tail: number;
}

function piecesOf(
  geometry: StripDragGeometry,
  groups: ReadonlyArray<StripGroupExtent>,
): ReadonlyArray<Piece> {
  const rows = geometry.slots.map((slot): Piece => ({
    slot,
    group: null,
    start: slot.contentStart,
    end: slot.contentStart + slot.extent,
  }));
  const collapsed = groups
    .filter((group) => !geometry.slots.some((s) => s.groupId === group.groupId))
    .map((group): Piece => ({
      slot: null,
      group,
      start: group.start,
      end: group.end,
    }));
  return [...rows, ...collapsed].sort((a, b) => a.start - b.start);
}

function chromeOf(
  group: StripGroupExtent,
  pieces: ReadonlyArray<Piece>,
): Chrome | null {
  const rows = pieces.filter((p) => p.slot?.groupId === group.groupId);
  if (rows.length === 0) return null;
  return {
    lead: Math.min(...rows.map((p) => p.start)) - group.start,
    tail: group.end - Math.max(...rows.map((p) => p.end)),
  };
}

/** The groups drawn in the section the dragged slot is in, which are the ones the drag lays out. */
export function laneGroupsOf(
  geometry: StripDragGeometry,
): ReadonlyArray<StripGroupExtent> {
  const lane = geometry.slots[geometry.sourceIndex]?.lane ?? null;
  return geometry.groups.filter((group) => group.lane === lane);
}

/**
 * The strip laid out with the dragged slot moved to `targetIndex` and put in
 * `groupId` (`null` for none), for a strip that has groups to lay out around.
 */
export function chromeLayoutFor(
  geometry: StripDragGeometry,
  targetIndex: number,
  groupId: string | null,
): StripLayout {
  const source = geometry.slots[geometry.sourceIndex];
  const groups = laneGroupsOf(geometry);
  const natural = piecesOf(geometry, groups);
  const naturalIndex = new Map(
    natural.map((piece, index) => [piece, index] as const),
  );
  const chromes = new Map(
    groups.map((group) => [group.groupId, chromeOf(group, natural)] as const),
  );
  const chromeFor = (id: string | null): Chrome | null =>
    id === null ? null : (chromes.get(id) ?? null);
  // The dragged tab joins a group only if that group draws tabs to sit among.
  const draggedGroupId = chromeFor(groupId) === null ? null : groupId;
  const groupOf = (piece: Piece): string | null => {
    if (piece.slot === null) return null;
    return piece.slot.itemId === source.itemId
      ? draggedGroupId
      : piece.slot.groupId;
  };
  const gapBetween = (a: Piece, b: Piece): number => {
    const unchanged = (piece: Piece): boolean =>
      groupOf(piece) === (piece.slot?.groupId ?? null);
    if (
      naturalIndex.get(b) === (naturalIndex.get(a) ?? -2) + 1 &&
      unchanged(a) &&
      unchanged(b)
    ) {
      return b.start - a.end;
    }
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga !== null && ga === gb) {
      return groups.find((g) => g.groupId === ga)?.rowGap ?? 0;
    }
    return (
      geometry.runGap + (chromeFor(ga)?.tail ?? 0) + (chromeFor(gb)?.lead ?? 0)
    );
  };
  const order = provisionalOrder(natural, source.itemId, targetIndex);
  const starts = new Map<Piece, number>();
  let previous: Piece | null = null;
  for (const piece of order) {
    const start: number =
      previous === null
        ? firstStart(natural, groups) + (chromeFor(groupOf(piece))?.lead ?? 0)
        : (starts.get(previous) ?? 0) +
          (previous.end - previous.start) +
          gapBetween(previous, piece);
    starts.set(piece, start);
    previous = piece;
  }
  const offsets = new Map<string, number>();
  for (const piece of order) {
    if (piece.slot === null) continue;
    offsets.set(piece.slot.itemId, (starts.get(piece) ?? 0) - piece.start);
  }
  return {
    offsets,
    groups: groups.map((group) =>
      placementOf(group, { order, starts, groupOf }, chromeFor(group.groupId)),
    ),
  };
}

/** Where the strip's first item, or the chrome before it, begins. */
function firstStart(
  natural: ReadonlyArray<Piece>,
  groups: ReadonlyArray<StripGroupExtent>,
): number {
  return Math.min(
    ...natural.map((piece) => piece.start),
    ...groups.map((group) => group.start),
  );
}

/** The natural pieces with the dragged tab's moved before the slot at `targetIndex`. */
function provisionalOrder(
  natural: ReadonlyArray<Piece>,
  sourceItemId: string,
  targetIndex: number,
): ReadonlyArray<Piece> {
  const dragged = natural.find((piece) => piece.slot?.itemId === sourceItemId);
  const rest = natural.filter((piece) => piece !== dragged);
  if (dragged === undefined) return natural;
  let rowsBefore = 0;
  const at = rest.findIndex((piece) => {
    if (piece.slot === null) return false;
    rowsBefore += 1;
    return rowsBefore > targetIndex;
  });
  const insertion = at === -1 ? rest.length : at;
  return [...rest.slice(0, insertion), dragged, ...rest.slice(insertion)];
}

/** The strip as laid out for a drop: the pieces in order, where each starts and each one's group. */
interface Provisional {
  readonly order: ReadonlyArray<Piece>;
  readonly starts: ReadonlyMap<Piece, number>;
  readonly groupOf: (piece: Piece) => string | null;
}

function placementOf(
  group: StripGroupExtent,
  { order, starts, groupOf }: Provisional,
  chrome: Chrome | null,
): StripGroupPlacement {
  const { groupId, lane } = group;
  const rows = order.filter((piece) => groupOf(piece) === groupId);
  const first = rows.at(0);
  const last = rows.at(-1);
  if (first !== undefined && last !== undefined && chrome !== null) {
    const start = (starts.get(first) ?? 0) - chrome.lead;
    const end = (starts.get(last) ?? 0) + (last.end - last.start) + chrome.tail;
    return {
      groupId,
      lane,
      offset: start - group.start,
      grow: end - start - (group.end - group.start),
      visible: true,
    };
  }
  const collapsed = order.find((piece) => piece.group === group);
  const moved = collapsed === undefined ? 0 : (starts.get(collapsed) ?? 0);
  return {
    groupId,
    lane,
    offset: collapsed === undefined ? 0 : moved - group.start,
    grow: 0,
    visible: collapsed !== undefined,
  };
}
