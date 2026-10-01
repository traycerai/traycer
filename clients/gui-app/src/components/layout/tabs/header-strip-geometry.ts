/**
 * DOM measurement for the header strip drag model. Kept apart from the model
 * itself so the model stays a pure function testable without a browser.
 *
 * Slots and extents are re-measured while dragging so layout changes cannot
 * stale the model. The strip's content origin is also re-read every frame:
 * dnd-kit's autoScroll can move it without pointer input. Render transforms are
 * subtracted from slot measurements to recover stable layout-space geometry.
 */
import { cssEscape } from "@/lib/dom/css-escape";
import {
  stripAxisOf,
  contentDirectionOf,
  type ContentDirection,
  type StripAxis,
  type StripAxisId,
  type StripEdge,
} from "@/components/epic-canvas/dnd/strip-axis";
import type { RectLike } from "@/components/epic-canvas/dnd/dnd";
import {
  laneSlotsOf,
  type StripDragGeometry,
  type StripGroupExtent,
  type StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";
import { useTabsStore } from "@/stores/tabs/store";
import { stripItemGroupId } from "@/stores/tabs/tab-groups";

export const HEADER_STRIP_SCROLL_TEST_ID = "header-tab-strip-scroll";

interface HeaderStripLayoutRect {
  readonly start: number;
  readonly end: number;
  readonly extent: number;
}

/**
 * The frame's rendered translate along `axis`, read from its computed
 * transform matrix: index 4 (x) or 5 (y) of `matrix(...)`, 12 or 13 of
 * `matrix3d(...)`. Zero when there is no transform.
 */
export function readTranslate(frame: HTMLElement, axis: StripAxis): number {
  const transform = getComputedStyle(frame).transform;
  if (transform === "none" || transform.length === 0) return 0;
  const values = transform.slice(transform.indexOf("(") + 1, -1).split(",");
  const is3d = transform.startsWith("matrix3d(");
  const index = (is3d ? 12 : 4) + (axis.id === "x" ? 0 : 1);
  const translate = Number(values[index]);
  return Number.isFinite(translate) ? translate : 0;
}

/**
 * Stable viewport bounds, along `axis`, of a strip item or one of its split
 * members. Remove the enclosing frame's drag displacement while retaining
 * each member's own offset. Reorder measurements must not depend on how far
 * the tween has run: its completion changes neither layout size nor DOM order.
 */
export function readHeaderStripLayoutRect(
  element: HTMLElement,
  axis: StripAxis,
): HeaderStripLayoutRect {
  const rect = element.getBoundingClientRect();
  const frame = element.closest<HTMLElement>(
    "[data-strip-item-id], [data-strip-group-chip-frame]",
  );
  const translate = frame === null ? 0 : readTranslate(frame, axis);
  return {
    start: axis.mainStart(rect) - translate,
    end: axis.mainEnd(rect) - translate,
    extent: axis.mainExtent(rect),
  };
}

function stripElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${HEADER_STRIP_SCROLL_TEST_ID}"]`,
  );
}

function readStripAxisId(value: string | undefined): StripAxisId | null {
  return value === "x" || value === "y" ? value : null;
}

function readStripEdge(value: string | undefined): StripEdge | null {
  return value === "top" || value === "left" || value === "right"
    ? value
    : null;
}

/** What a strip presentation declares about itself on its scroller. */
export interface HeaderStripDeclaration {
  readonly axis: StripAxis;
  readonly contentDirection: ContentDirection;
}

/**
 * The axis and content direction the mounted strip presentation declares on
 * its scroller (`data-strip-axis`, `data-strip-edge`). Null when there is no
 * strip or it does not declare both: a strip without them is a bug, and no
 * axis is assumed for it.
 */
export function readHeaderStripSession(): HeaderStripDeclaration | null {
  const strip = stripElement();
  if (strip === null) return null;
  const axisId = readStripAxisId(strip.dataset.stripAxis);
  const edge = readStripEdge(strip.dataset.stripEdge);
  if (axisId === null || edge === null) return null;
  return {
    axis: stripAxisOf(axisId),
    contentDirection: contentDirectionOf(edge),
  };
}

/**
 * Viewport position of the strip's content origin along `axis`. Cheap enough
 * to call per frame, and the strip container is not layout-animated, so
 * reading it cannot feed back into the springs it governs.
 */
export function readHeaderStripContentOrigin(axis: StripAxis): number | null {
  const strip = stripElement();
  if (strip === null) return null;
  return (
    axis.mainStart(strip.getBoundingClientRect()) - axis.scrollOffset(strip)
  );
}

/** The tab group each strip item is in, read from the live tabs store. */
function stripItemGroupIds(): ReadonlyMap<string, string | null> {
  const { items, customizations } = useTabsStore.getState();
  return new Map(
    items.map((item) => [item.id, stripItemGroupId(item, customizations)]),
  );
}

export function readHeaderStripSlots(
  axis: StripAxis,
): ReadonlyArray<StripSlot> {
  const strip = stripElement();
  if (strip === null) return [];
  const origin =
    axis.mainStart(strip.getBoundingClientRect()) - axis.scrollOffset(strip);
  const groupIds = stripItemGroupIds();
  const measured: Array<{
    readonly itemId: string;
    readonly extent: number;
    readonly contentStart: number;
    readonly isMergeTarget: boolean;
    readonly lane: string | null;
    readonly groupId: string | null;
  }> = [];
  for (const child of strip.querySelectorAll<HTMLElement>(
    "[data-strip-item-id]",
  )) {
    const itemId = child.dataset.stripItemId;
    if (itemId === undefined || itemId.length === 0) continue;
    const rect = readHeaderStripLayoutRect(child, axis);
    measured.push({
      itemId,
      extent: rect.extent,
      contentStart: rect.start - origin,
      isMergeTarget: child.dataset.stripItemMergeable !== "false",
      lane: child.dataset.stripLane ?? null,
      groupId: groupIds.get(itemId) ?? null,
    });
  }
  // `order` reorders the flex row visually but not in the DOM, so at drag start
  // - when nothing is displaced yet - document order is strip order. Sorting by
  // measured position keeps that true even if a drag is somehow re-measured
  // mid-displacement.
  const sorted = measured
    .slice()
    .sort((left, right) => left.contentStart - right.contentStart);
  return sorted.map((slot, index) => ({
    ...slot,
    // Measured, not assumed: any wrapper margin or border shows up here
    // instead of accumulating into every downstream centre.
    advance:
      index + 1 < sorted.length
        ? sorted[index + 1].contentStart - slot.contentStart
        : slot.extent,
  }));
}

/** The main-axis gap a flex container lays its children out with, in px. */
function mainAxisGap(element: HTMLElement, axis: StripAxis): number {
  const style = getComputedStyle(element);
  return (
    Number.parseFloat(axis.id === "y" ? style.rowGap : style.columnGap) || 0
  );
}

/**
 * Whether a drag may not change a group's membership: an organization's group,
 * the same ones the appearance menu will not add a tab to.
 */
function groupIsLocked(groupId: string): boolean {
  const group = useTabsStore.getState().groups?.[groupId];
  return Boolean(group?.organizationOwnerId);
}

/**
 * Where each tab group is drawn. A sidebar block or rail column marks itself
 * (`data-strip-group-extent`) and spans its header and rows. The top bar's
 * group has no box of its own: its chip frame (`data-strip-group-chip-frame`,
 * the chip and its margins) and its tabs, which follow the chip, are the
 * extent, and a collapsed group's is its chip. A block's rect carries no drag
 * displacement (only the fill and header inside it move); a chip frame's does,
 * and it is removed, as a tab's is.
 */
export function readHeaderStripGroups(
  axis: StripAxis,
  slots: ReadonlyArray<StripSlot>,
): ReadonlyArray<StripGroupExtent> {
  const strip = stripElement();
  if (strip === null) return [];
  const origin =
    axis.mainStart(strip.getBoundingClientRect()) - axis.scrollOffset(strip);
  const extents: StripGroupExtent[] = [];
  for (const block of strip.querySelectorAll<HTMLElement>(
    "[data-strip-group-extent]",
  )) {
    const rect = block.getBoundingClientRect();
    const groupId = block.dataset.stripGroupExtent ?? "";
    extents.push({
      groupId,
      start: axis.mainStart(rect) - origin,
      end: axis.mainEnd(rect) - origin,
      lane: block.dataset.stripLane ?? null,
      rowGap: mainAxisGap(block, axis),
      locked: groupIsLocked(groupId),
    });
  }
  for (const frame of strip.querySelectorAll<HTMLElement>(
    "[data-strip-group-chip-frame]",
  )) {
    const groupId = frame.dataset.stripGroupChipFrame ?? "";
    const rect = readHeaderStripLayoutRect(frame, axis);
    const membersEnd = slots
      .filter((slot) => slot.groupId === groupId)
      .map((slot) => slot.contentStart + slot.extent);
    extents.push({
      groupId,
      start: rect.start - origin,
      end: Math.max(rect.end - origin, ...membersEnd),
      lane: null,
      rowGap: 0,
      locked: groupIsLocked(groupId),
    });
  }
  return extents;
}

/**
 * Rendered bounds of a strip item, for the drag overlay to take. Null when the
 * item is not in the strip.
 */
export function readHeaderStripItemRect(stripItemId: string): RectLike | null {
  const item = stripElement()?.querySelector<HTMLElement>(
    `[data-strip-item-id="${cssEscape(stripItemId)}"]`,
  );
  if (item === null || item === undefined) return null;
  const rect = item.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Full geometry for a gesture that just started on `stripItemId`, with
 * `pointer` the press position along `axis`. The band is the scroller's
 * extent on the cross axis. Returns null when the strip or the dragged item is
 * not measurable, which the caller treats as "no model" and falls back to
 * leaving the strip alone.
 */
export function measureHeaderStripGeometry(input: {
  readonly stripItemId: string;
  readonly pointer: number;
  readonly axis: StripAxis;
}): StripDragGeometry | null {
  const { axis } = input;
  const strip = stripElement();
  if (strip === null) return null;
  const stripSlots = readHeaderStripSlots(axis);
  const slots = laneSlotsOf(stripSlots, input.stripItemId);
  const sourceIndex = slots.findIndex(
    (slot) => slot.itemId === input.stripItemId,
  );
  if (sourceIndex < 0) return null;
  const source = slots[sourceIndex];
  const stripRect = strip.getBoundingClientRect();
  const origin = axis.mainStart(stripRect) - axis.scrollOffset(strip);
  return {
    slots,
    groups: readHeaderStripGroups(axis, stripSlots),
    runGap: mainAxisGap(strip, axis),
    sourceIndex,
    grabOffset: input.pointer - (origin + source.contentStart),
    sourceInitialStart: origin + source.contentStart,
    sourceExtent: source.extent,
    bandStart: axis.crossStart(stripRect),
    bandEnd: axis.crossEnd(stripRect),
  };
}
