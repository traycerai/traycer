/** Kept apart from the model itself so the model stays a pure function testable without a browser. Slots and
 * widths are re-measured while dragging so layout changes cannot stale the model. */
import type {
  StripDragGeometry,
  StripSlot,
} from "@/components/epic-canvas/dnd/strip-drag-model";

export const HEADER_STRIP_SCROLL_TEST_ID = "header-tab-strip-scroll";

function stripElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${HEADER_STRIP_SCROLL_TEST_ID}"]`,
  );
}

/** Cheap enough to call per frame, and the strip container is not layout-animated, so reading it cannot feed
 * back into the springs it governs. */
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
    const rect = child.getBoundingClientRect();
    const transform = getComputedStyle(child).transform;
    const values = transform.slice(transform.indexOf("(") + 1, -1).split(",");
    const parsedTranslateX = Number(
      values[transform.startsWith("matrix3d(") ? 12 : 4],
    );
    const translateX = Number.isFinite(parsedTranslateX) ? parsedTranslateX : 0;
    measured.push({
      itemId,
      width: rect.width,
      contentLeft: rect.left - originX - translateX,
      isMergeTarget: child.dataset.stripItemMergeable !== "false",
    });
  }
  // `order` reorders the flex row visually but not in the DOM, so at drag start - when nothing is displaced yet
  // - document order is strip order.
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

/** Returns null when the strip or the dragged item is not measurable, which the caller treats as "no model" and
 * falls back to leaving the strip alone. */
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
