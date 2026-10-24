import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import { listNavigationKey } from "@/lib/keybindings/list-navigation-key";
import type { VirtuosoHandle } from "react-virtuoso";
import type { KeyboardEvent, RefObject } from "react";

interface HarnessModelPickerKeyboardInput {
  readonly visibleRows: ReadonlyArray<HarnessModelRow>;
  readonly effectiveActiveRowId: string;
  readonly activeRow: HarnessModelRow | null;
  readonly trimmedQuery: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly onActiveRowId: (rowId: string) => void;
  readonly onSelectRow: (row: HarnessModelRow) => void;
  readonly onQueryChange: (next: string) => void;
  readonly onClose: () => void;
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

  const navigationKey = listNavigationKey(event);

  if (navigationKey === "ArrowDown") {
    event.preventDefault();
    moveActiveRow({ ...navigation, direction: 1 });
    return;
  }

  if (navigationKey === "ArrowUp") {
    event.preventDefault();
    moveActiveRow({ ...navigation, direction: -1 });
    return;
  }

  if (event.key === "Home") {
    event.preventDefault();
    activateRowIndex({ ...navigation, index: 0, align: "start" });
    return;
  }

  if (event.key === "End") {
    event.preventDefault();
    activateRowIndex({
      ...navigation,
      index: visibleRows.length - 1,
      align: "end",
    });
    return;
  }

  if (event.key === "Enter") {
    if (activeRow === null) return;
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
  readonly visibleRows: ReadonlyArray<HarnessModelRow>;
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
  if (visibleRows.length === 0) return;
  const currentIndex = visibleRows.findIndex(
    (row) => row.id === effectiveActiveRowId,
  );
  const fallbackIndex = direction > 0 ? -1 : visibleRows.length;
  const nextIndex = clampIndex(
    (currentIndex === -1 ? fallbackIndex : currentIndex) + direction,
    visibleRows.length,
  );
  onActiveRowId(visibleRows.at(nextIndex)?.id ?? "");
  listRef.current?.scrollIntoView({
    index: nextIndex,
    behavior: "auto",
  });
}

function activateRowIndex(
  input: RowNavigationInput & {
    readonly index: number;
    readonly align: "center" | "end" | "start";
  },
): void {
  const { visibleRows, listRef, onActiveRowId, index, align } = input;
  const row = visibleRows.at(index);
  if (row === undefined) return;
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
