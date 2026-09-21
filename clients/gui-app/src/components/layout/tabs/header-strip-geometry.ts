/**
 * DOM measurement for the header strip drag model. Kept apart from the model
 * itself so the model stays a pure function testable without a browser.
 *
 * Slots and widths are re-measured while dragging so layout changes cannot
 * stale the model. The strip's content origin is also re-read every frame:
 * dnd-kit's autoScroll can move it without pointer input. Render transforms are
 * subtracted from slot measurements to recover stable layout-space geometry.
 */
import type {
  StripDragGeometry,
  StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

export const HEADER_STRIP_SCROLL_TEST_ID = "header-tab-strip-scroll";

interface HeaderStripLayoutRect {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

/**
 * Stable viewport bounds of a strip item or one of its split members. Remove
 * the enclosing frame's drag displacement while retaining each member's own
 * offset. Reorder measurements must not depend on how far the tween has run:
 * its completion changes neither layout size nor DOM order.
 */
export function readHeaderStripLayoutRect(
  element: HTMLElement,
): HeaderStripLayoutRect {
  const rect = element.getBoundingClientRect();
  const frame = element.closest<HTMLElement>("[data-strip-item-id]");
  const transform = frame === null ? "none" : getComputedStyle(frame).transform;
  const values = transform.slice(transform.indexOf("(") + 1, -1).split(",");
  const parsedTranslateX = Number(
    values[transform.startsWith("matrix3d(") ? 12 : 4],
  );
  const translateX = Number.isFinite(parsedTranslateX) ? parsedTranslateX : 0;
  return {
    left: rect.left - translateX,
    right: rect.right - translateX,
    width: rect.width,
  };
}

function stripElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${HEADER_STRIP_SCROLL_TEST_ID}"]`,
  );
}

/**
 * Viewport x of the strip's content origin. Cheap enough to call per frame, and
 * the strip container is not layout-animated, so reading it cannot feed back
 * into the springs it governs.
 */
export function readHeaderStripContentOriginX(): number | null {
  const strip = stripElement();
  if (strip === null) return null;
  return strip.getBoundingClientRect().left - strip.scrollLeft;
}

export function readHeaderStripSlots(): ReadonlyArray<StripSlot> {
  const strip = stripElement();
  if (strip === null) return [];
  const originX = strip.getBoundingClientRect().left - strip.scrollLeft;
  const measured: Array<{
    readonly itemId: string;
    readonly width: number;
    readonly contentLeft: number;
    readonly isMergeTarget: boolean;
  }> = [];
  for (const child of strip.querySelectorAll<HTMLElement>(
    "[data-strip-item-id]",
  )) {
    const itemId = child.dataset.stripItemId;
    if (itemId === undefined || itemId.length === 0) continue;
    const rect = readHeaderStripLayoutRect(child);
    measured.push({
      itemId,
      width: rect.width,
      contentLeft: rect.left - originX,
      isMergeTarget: child.dataset.stripItemMergeable !== "false",
    });
  }
  // `order` reorders the flex row visually but not in the DOM, so at drag start
  // - when nothing is displaced yet - document order is strip order. Sorting by
  // measured position keeps that true even if a drag is somehow re-measured
  // mid-displacement.
  const sorted = measured
    .slice()
    .sort((left, right) => left.contentLeft - right.contentLeft);
  return sorted.map((slot, index) => ({
    ...slot,
    // Measured, not assumed: any wrapper margin or border shows up here
    // instead of accumulating into every downstream centre.
    advance:
      index + 1 < sorted.length
        ? sorted[index + 1].contentLeft - slot.contentLeft
        : slot.width,
  }));
}

/**
 * Full geometry for a gesture that just started on `stripItemId`. Returns null
 * when the strip or the dragged item is not measurable, which the caller treats
 * as "no model" and falls back to leaving the strip alone.
 */
export function measureHeaderStripGeometry(input: {
  readonly stripItemId: string;
  readonly pointerX: number;
}): StripDragGeometry | null {
  const strip = stripElement();
  if (strip === null) return null;
  const slots = readHeaderStripSlots();
  const sourceIndex = slots.findIndex(
    (slot) => slot.itemId === input.stripItemId,
  );
  if (sourceIndex < 0) return null;
  const source = slots[sourceIndex];
  const stripRect = strip.getBoundingClientRect();
  const originX = stripRect.left - strip.scrollLeft;
  return {
    slots,
    sourceIndex,
    grabOffsetX: input.pointerX - (originX + source.contentLeft),
    sourceInitialLeft: originX + source.contentLeft,
    sourceWidth: source.width,
    stripTop: stripRect.top,
    stripBottom: stripRect.bottom,
  };
}
