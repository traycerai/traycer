/**
 * Header tab strip drag payloads + readers. Header tabs participate in the
 * single root DndContext (`root-dnd-provider.tsx`): each tab is a draggable
 * (`header-tab`) and a droppable slot (`header-tab-slot`), and the strip's
 * tab row is a trailing slot covering the empty space after the
 * last tab. Canvas tear-off lands on the same slots - there is no separate
 * geometry bridge.
 */
import { TAB_KINDS, type HeaderTabKind } from "@/stores/tabs/registry";
import { isRecord, type RectLike } from "@/components/epic-canvas/dnd/dnd";

export const HEADER_TAB_DND_TYPE = "header-tab";
export const HEADER_TAB_SLOT_DND_TYPE = "header-tab-slot";

export interface HeaderTabDragData {
  readonly kind: typeof HEADER_TAB_DND_TYPE;
  readonly tabKind: HeaderTabKind;
  readonly tabId: string;
  /** Rendered strip index at drag start - drives reorder noop suppression. */
  readonly index: number;
}

/**
 * One droppable slot per header tab plus one trailing slot for the strip's
 * empty space. `index` is the slot's tab index (trailing slot = tab count);
 * the insertion index is refined against the pointer x at resolve time.
 */
export interface HeaderTabSlotDropData {
  readonly kind: typeof HEADER_TAB_SLOT_DND_TYPE;
  readonly index: number;
  readonly isTrailing: boolean;
}

export function getHeaderTabDragId(kind: HeaderTabKind, id: string): string {
  return `header-tab:${kind}:${id}`;
}

export function getHeaderTabSlotDropId(
  kind: HeaderTabKind,
  id: string,
): string {
  return `header-tab-slot:${kind}:${id}`;
}

export const HEADER_TAB_TRAILING_SLOT_DROP_ID = "header-tab-slot:trailing";

function isHeaderTabKind(value: string): value is HeaderTabKind {
  return Object.prototype.hasOwnProperty.call(TAB_KINDS, value);
}

function readHeaderTabKind(value: unknown): HeaderTabKind | null {
  if (typeof value !== "string") return null;
  return isHeaderTabKind(value) ? value : null;
}

export function readHeaderTabDragData(
  value: unknown,
): HeaderTabDragData | null {
  if (!isRecord(value)) return null;
  const tabKind = readHeaderTabKind(value.tabKind);
  if (
    value.kind !== HEADER_TAB_DND_TYPE ||
    tabKind === null ||
    typeof value.tabId !== "string" ||
    value.tabId.length === 0 ||
    typeof value.index !== "number" ||
    !Number.isInteger(value.index) ||
    value.index < 0
  ) {
    return null;
  }
  return {
    kind: HEADER_TAB_DND_TYPE,
    tabKind,
    tabId: value.tabId,
    index: value.index,
  };
}

export function readHeaderTabSlotDropData(
  value: unknown,
): HeaderTabSlotDropData | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== HEADER_TAB_SLOT_DND_TYPE ||
    typeof value.index !== "number" ||
    !Number.isInteger(value.index) ||
    value.index < 0 ||
    typeof value.isTrailing !== "boolean"
  ) {
    return null;
  }
  return {
    kind: HEADER_TAB_SLOT_DND_TYPE,
    index: value.index,
    isTrailing: value.isTrailing,
  };
}

/**
 * Pointer-x midpoint insertion-index resolution over a header slot, with
 * reorder noop suppression for header-tab sources (`sourceIndex` is the
 * dragged tab's rendered index; pass null for canvas tear-off sources,
 * which have no noop slot).
 */
export function resolveHeaderStripDropIndex(input: {
  readonly slot: HeaderTabSlotDropData;
  readonly pointerX: number;
  readonly slotRect: RectLike | null;
  readonly sourceIndex: number | null;
}): number | null {
  const { slot, pointerX, slotRect, sourceIndex } = input;
  const insertAfterSlot =
    !slot.isTrailing &&
    slotRect !== null &&
    pointerX >= slotRect.left + slotRect.width / 2;
  const rawIndex = insertAfterSlot ? slot.index + 1 : slot.index;
  if (sourceIndex !== null) {
    if (rawIndex === sourceIndex || rawIndex === sourceIndex + 1) return null;
  }
  return rawIndex;
}
