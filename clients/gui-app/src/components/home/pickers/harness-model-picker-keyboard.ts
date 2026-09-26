import type { HarnessModelPickerRow } from "@/components/home/data/harness-model-search";
import type { VirtuosoHandle } from "react-virtuoso";
import type { KeyboardEvent, RefObject } from "react";

interface HarnessModelPickerKeyboardInput {
  readonly visibleRows: ReadonlyArray<HarnessModelPickerRow>;
  readonly effectiveActiveRowId: string;
  readonly activeRow: HarnessModelPickerRow | null;
  readonly trimmedQuery: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly onActiveRowId: (rowId: string) => void;
  readonly onSelectRow: (row: HarnessModelPickerRow) => void;
  readonly onQueryChange: (next: string) => void;
  readonly onClose: () => void;
}

/** The option element's id, which the search input names as its active descendant. */
export function modelRowElementId(idPrefix: string, rowId: string): string {
  return `${idPrefix}-row-${rowId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Whether the arrows, Home/End and Enter can land on a row. The injected
 * section's heading is a label, not an option, so navigation steps over it; a
 * dimmed suggestion stays reachable (its reason is worth reading), and Enter on
 * it is the select handler's no-op.
 */
export function isNavigableRow(row: HarnessModelPickerRow): boolean {
  return row.kind !== "suggestion-heading";
}

export function handleHarnessModelPickerKeyDown(
  event: KeyboardEvent<HTMLElement>,
  input: HarnessModelPickerKeyboardInput,
): void {
  const {
    visibleRows,
    effectiveActiveRowId,
    activeRow,
    trimmedQuery,
    listRef,
    onActiveRowId,
    onSelectRow,
    onQueryChange,
    onClose,
  } = input;

  const navigation = {
    visibleRows,
    effectiveActiveRowId,
    listRef,
    onActiveRowId,
  };

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveActiveRow({ ...navigation, direction: 1 });
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveActiveRow({ ...navigation, direction: -1 });
    return;
  }

  if (event.key === "Home") {
    event.preventDefault();
    activateRowIndex({
      ...navigation,
      index: visibleRows.findIndex(isNavigableRow),
      align: "start",
    });
    return;
  }

  if (event.key === "End") {
    event.preventDefault();
    activateRowIndex({
      ...navigation,
      index: visibleRows.findLastIndex(isNavigableRow),
      align: "end",
    });
    return;
  }

  if (event.key === "Enter") {
    if (activeRow === null || !isNavigableRow(activeRow)) return;
    event.preventDefault();
    onSelectRow(activeRow);
    return;
  }

  if (event.key === "Escape") {
    if (trimmedQuery.length === 0) {
      onClose();
      return;
    }
    event.preventDefault();
    onQueryChange("");
  }
}

interface RowNavigationInput {
  readonly visibleRows: ReadonlyArray<HarnessModelPickerRow>;
  readonly effectiveActiveRowId: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly onActiveRowId: (rowId: string) => void;
}

function moveActiveRow(
  input: RowNavigationInput & { readonly direction: 1 | -1 },
): void {
  const {
    visibleRows,
    effectiveActiveRowId,
    listRef,
    onActiveRowId,
    direction,
  } = input;
  if (!visibleRows.some(isNavigableRow)) return;
  const currentIndex = visibleRows.findIndex(
    (row) => row.id === effectiveActiveRowId,
  );
  const fallbackIndex = direction > 0 ? -1 : visibleRows.length;
  const nextIndex = nextNavigableIndex(
    visibleRows,
    currentIndex === -1 ? fallbackIndex : currentIndex,
    direction,
  );
  onActiveRowId(visibleRows.at(nextIndex)?.id ?? "");
  listRef.current?.scrollIntoView({
    index: nextIndex,
    behavior: "auto",
  });
}

/**
 * The next navigable index from `from` in `direction`, clamped at the ends -
 * where there is no navigable row further along, the arrow stays on the
 * current one, as it always has at the top and bottom of the list.
 */
function nextNavigableIndex(
  rows: ReadonlyArray<HarnessModelPickerRow>,
  from: number,
  direction: 1 | -1,
): number {
  for (
    let index = from + direction;
    index >= 0 && index < rows.length;
    index += direction
  ) {
    const row = rows.at(index);
    if (row !== undefined && isNavigableRow(row)) return index;
  }
  return clampIndex(from, rows.length);
}

function activateRowIndex(
  input: RowNavigationInput & {
    readonly index: number;
    readonly align: "center" | "end" | "start";
  },
): void {
  const { visibleRows, listRef, onActiveRowId, index, align } = input;
  const row = visibleRows.at(index);
  if (index < 0 || row === undefined) return;
  onActiveRowId(row.id);
  listRef.current?.scrollToIndex({
    index,
    align,
    behavior: "auto",
  });
}

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
