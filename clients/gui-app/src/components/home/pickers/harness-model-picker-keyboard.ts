import type { VirtuosoHandle } from "react-virtuoso";
import type { KeyboardEvent, RefObject } from "react";

/** Navigable row shape shared by models, subproviders, and efforts. */
export interface CascadeNavItem {
  readonly id: string;
}

interface HarnessModelPickerKeyboardInput {
  readonly visibleItems: ReadonlyArray<CascadeNavItem>;
  readonly effectiveActiveRowId: string;
  readonly activeItemId: string | null;
  readonly trimmedQuery: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly canNavigateCascade: boolean;
  readonly onActiveRowId: (rowId: string) => void;
  readonly onSelectActive: () => void;
  readonly onQueryChange: (next: string) => void;
  readonly onCascadeBack: () => void;
  readonly onClose: () => void;
}

export function handleHarnessModelPickerKeyDown(
  event: KeyboardEvent<HTMLElement>,
  input: HarnessModelPickerKeyboardInput,
): void {
  const {
    visibleItems,
    effectiveActiveRowId,
    activeItemId,
    trimmedQuery,
    listRef,
    canNavigateCascade,
    onActiveRowId,
    onSelectActive,
    onQueryChange,
    onCascadeBack,
    onClose,
  } = input;

  const navigation = {
    visibleItems,
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
    activateRowIndex({ ...navigation, index: 0, align: "start" });
    return;
  }

  if (event.key === "End") {
    event.preventDefault();
    activateRowIndex({
      ...navigation,
      index: visibleItems.length - 1,
      align: "end",
    });
    return;
  }

  if (event.key === "Enter") {
    if (activeItemId === null) return;
    event.preventDefault();
    onSelectActive();
    return;
  }

  // Level-up: ArrowLeft always (when cascade allows and query empty).
  if (
    event.key === "ArrowLeft" &&
    trimmedQuery.length === 0 &&
    canNavigateCascade
  ) {
    event.preventDefault();
    onCascadeBack();
    return;
  }

  // Backspace with empty query goes up one cascade level (never deletes nothing).
  if (
    event.key === "Backspace" &&
    trimmedQuery.length === 0 &&
    canNavigateCascade
  ) {
    event.preventDefault();
    onCascadeBack();
    return;
  }

  if (event.key === "Escape") {
    if (trimmedQuery.length === 0) {
      if (canNavigateCascade) {
        event.preventDefault();
        onCascadeBack();
        return;
      }
      onClose();
      return;
    }
    event.preventDefault();
    onQueryChange("");
  }
}

interface RowNavigationInput {
  readonly visibleItems: ReadonlyArray<CascadeNavItem>;
  readonly effectiveActiveRowId: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly onActiveRowId: (rowId: string) => void;
}

function moveActiveRow(
  input: RowNavigationInput & { readonly direction: 1 | -1 },
): void {
  const {
    visibleItems,
    effectiveActiveRowId,
    listRef,
    onActiveRowId,
    direction,
  } = input;
  if (visibleItems.length === 0) return;
  const currentIndex = visibleItems.findIndex(
    (item) => item.id === effectiveActiveRowId,
  );
  const fallbackIndex = direction > 0 ? -1 : visibleItems.length;
  const nextIndex = clampIndex(
    (currentIndex === -1 ? fallbackIndex : currentIndex) + direction,
    visibleItems.length,
  );
  onActiveRowId(visibleItems.at(nextIndex)?.id ?? "");
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
  const { visibleItems, listRef, onActiveRowId, index, align } = input;
  const item = visibleItems.at(index);
  if (item === undefined) return;
  onActiveRowId(item.id);
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
