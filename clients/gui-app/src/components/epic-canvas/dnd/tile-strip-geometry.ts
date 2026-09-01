/**
 * DOM measurement for tile (in-task) strips, the canvas counterpart of
 * `header-strip-geometry.ts`. Kept apart from the model so the model stays a
 * pure function testable without a browser.
 *
 * Two things differ from the header. Tile widths are content-sized rather than
 * flex-equal, so every slot's width and advance are genuinely different and
 * must be measured per item. And the canvas has one strip PER GROUP, so every
 * lookup is group-scoped: a tile dragged from group A over group B resolves
 * against B's geometry, not A's.
 */
import type {
  StripDragGeometry,
  StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

/**
 * The scrolling element inside a group's strip; also its own droppable.
 *
 * Matched by comparing `dataset.groupId` rather than interpolating the id into
 * a selector: a group id is opaque, and `CSS.escape` is not available in every
 * environment this module runs in (jsdom has no `CSS` global).
 */
function stripScrollElement(groupId: string): HTMLElement | null {
  for (const strip of document.querySelectorAll<HTMLElement>(
    '[data-testid="tab-strip"][data-group-id]',
  )) {
    if (strip.dataset.groupId !== groupId) continue;
    return (
      strip.querySelector<HTMLElement>('[data-testid="tab-strip-end"]') ?? null
    );
  }
  return null;
}

function renderedTranslateX(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (transform === "none" || transform.length === 0) return 0;
  const values = transform.slice(transform.indexOf("(") + 1, -1).split(",");
  const x = Number(values[transform.startsWith("matrix3d(") ? 12 : 4]);
  return Number.isFinite(x) ? x : 0;
}

export function readTileStripContentOriginX(groupId: string): number | null {
  const el = stripScrollElement(groupId);
  if (el === null) return null;
  return el.getBoundingClientRect().left - el.scrollLeft;
}

export function readTileStripRect(groupId: string): DOMRect | null {
  return stripScrollElement(groupId)?.getBoundingClientRect() ?? null;
}

/** Every group id that currently renders a tile strip, in document order. */
export function readTileStripGroupIds(): ReadonlyArray<string> {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="tab-strip"][data-group-id]',
    ),
  ].flatMap((el) => {
    const groupId = el.dataset.groupId;
    return groupId === undefined || groupId.length === 0 ? [] : [groupId];
  });
}

/** The group whose strip row contains this point, or null. */
export function tileStripGroupAtPoint(
  point: { readonly x: number; readonly y: number },
  viewTabId: string,
): string | null {
  for (const strip of document.querySelectorAll<HTMLElement>(
    '[data-testid="tab-strip"][data-group-id][data-view-tab-id]',
  )) {
    if (strip.dataset.viewTabId !== viewTabId) continue;
    const groupId = strip.dataset.groupId;
    if (groupId === undefined || groupId.length === 0) continue;
    const rect = strip
      .querySelector<HTMLElement>('[data-testid="tab-strip-end"]')
      ?.getBoundingClientRect();
    // A collapsed or unmeasured strip has a zero-size rect, which would
    // otherwise "contain" the origin and capture every pointer at (0,0).
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) continue;
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      return groupId;
    }
  }
  return null;
}

/**
 * Slots for one tile strip, measured from live rects.
 *
 * Tile frames carry an explicit x transform while a drag is in flight. The
 * currently rendered transform is removed from each rect so measurements are
 * restored to layout-space before a mid-drag item-list remap.
 */
export function readTileStripSlots(groupId: string): ReadonlyArray<StripSlot> {
  const el = stripScrollElement(groupId);
  if (el === null) return [];
  const originX = el.getBoundingClientRect().left - el.scrollLeft;
  const measured = [
    ...el.querySelectorAll<HTMLElement>("[data-tile-item-id]"),
  ].flatMap((child) => {
    const itemId = child.dataset.tileItemId;
    if (itemId === undefined || itemId.length === 0) return [];
    const rect = child.getBoundingClientRect();
    return [
      {
        itemId,
        width: rect.width,
        contentLeft: rect.left - originX - renderedTranslateX(child),
        // Tile strips have no pair-into-split gesture, so no tile is ever a
        // merge target. This - not the zero band width - is what makes the
        // model's merge branch unreachable here.
        isMergeTarget: false,
      },
    ];
  });
  const sorted = measured
    .slice()
    .sort((left, right) => left.contentLeft - right.contentLeft);
  return sorted.map((slot, index) => ({
    ...slot,
    advance:
      index + 1 < sorted.length
        ? sorted[index + 1].contentLeft - slot.contentLeft
        : slot.width,
  }));
}

/**
 * Geometry for a gesture that just started on `tileItemId` inside `groupId`.
 * Returns null when the strip or the dragged tile is not measurable, which the
 * caller treats as "no model" and leaves the strip alone.
 */
export function measureTileStripGeometry(input: {
  readonly groupId: string;
  readonly tileItemId: string;
  readonly pointerX: number;
}): StripDragGeometry | null {
  const el = stripScrollElement(input.groupId);
  if (el === null) return null;
  const slots = readTileStripSlots(input.groupId);
  const sourceIndex = slots.findIndex(
    (slot) => slot.itemId === input.tileItemId,
  );
  if (sourceIndex < 0) return null;
  const source = slots[sourceIndex];
  const stripRect = el.getBoundingClientRect();
  const originX = stripRect.left - el.scrollLeft;
  return {
    slots,
    sourceIndex,
    grabOffsetX: input.pointerX - (originX + source.contentLeft),
    sourceInitialLeft: originX + source.contentLeft,
    sourceWidth: source.width,
    // Tile tabs have no pair-into-split gesture: the split lives on the pane
    // BODY, a different target. `readTileStripSlots` marks every slot
    // `isMergeTarget: false`, which is what keeps the model's merge branch
    // unreachable here.
    stripTop: stripRect.top,
    stripBottom: stripRect.bottom,
  };
}

/**
 * Geometry for a strip the dragged tile is being inserted INTO from another
 * group. It has no slot there, so `sourceIndex` is -1 and the caller uses
 * `insertionOffsetsFor` rather than the reorder path.
 */
export function measureForeignTileStrip(groupId: string): {
  readonly slots: ReadonlyArray<StripSlot>;
  readonly contentOriginX: number;
} | null {
  const originX = readTileStripContentOriginX(groupId);
  if (originX === null) return null;
  return {
    slots: readTileStripSlots(groupId),
    contentOriginX: originX,
  };
}
