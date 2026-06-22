import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { IndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import {
  createWorktreeBranchSearchIndex,
  filterWorktreeBranchRows,
} from "@/components/home/data/worktree-branch-search";
import {
  clampIndex,
  fallbackEntryId,
  pickerEntryDisabled,
  pickerEntryId,
  type PickerEntry,
  type WorktreeBranchPickerController,
  type WorktreeBranchPickerProps,
} from "@/components/home/worktree/worktree-branch-picker-model";

export function useWorktreeBranchPickerController(
  props: WorktreeBranchPickerProps,
): WorktreeBranchPickerController {
  const {
    actions,
    align,
    contentClassName,
    defaultOpen,
    emptyLabel,
    listboxLabel,
    onSelectRow,
    pinnedRows,
    portalContainer,
    rows,
    searchPlaceholder,
    side,
  } = props;
  const idPrefix = useId();
  const listboxId = `${idPrefix}-worktree-branch-listbox`;
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQueryState] = useState("");
  const [activeEntryId, setActiveEntryId] = useState("");
  const [openVersion, setOpenVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<VirtuosoHandle>(null);
  const suppressTriggerFocusRef = useRef(false);

  const searchIndex = useMemo(
    () => createWorktreeBranchSearchIndex(rows),
    [rows],
  );
  const filteredRows = useMemo(
    () => filterWorktreeBranchRows(rows, searchIndex, query),
    [rows, query, searchIndex],
  );
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const entries = useMemo<ReadonlyArray<PickerEntry>>(() => {
    const pinnedEntries: ReadonlyArray<PickerEntry> = pinnedRows.map(
      (option) => ({
        kind: "pinned",
        id: pickerEntryId("pinned", option.id),
        option,
      }),
    );
    const resultEntries: ReadonlyArray<PickerEntry> = filteredRows.map(
      (row, rowIndex) => ({
        kind: "result",
        id: pickerEntryId("result", row.id),
        row,
        rowIndex,
      }),
    );
    const actionEntries: ReadonlyArray<PickerEntry> = actions.map((action) => ({
      kind: "action",
      id: pickerEntryId("action", action.id),
      action,
    }));
    return [...pinnedEntries, ...resultEntries, ...actionEntries];
  }, [actions, filteredRows, pinnedRows]);
  const selectableEntries = useMemo(
    () => entries.filter((entry) => !pickerEntryDisabled(entry)),
    [entries],
  );
  const selectableEntryIds = useMemo(
    () => new Set(selectableEntries.map((entry) => entry.id)),
    [selectableEntries],
  );
  const fallbackActiveEntryId = useMemo(
    () => fallbackEntryId(selectableEntries),
    [selectableEntries],
  );
  const effectiveActiveEntryId = selectableEntryIds.has(activeEntryId)
    ? activeEntryId
    : fallbackActiveEntryId;
  const activeEntry =
    selectableEntries.find((entry) => entry.id === effectiveActiveEntryId) ??
    null;
  const selectedRowIndex = filteredRows.findIndex((row) => row.selected);
  const initialTopMostItemIndex: IndexLocationWithAlign = {
    index: selectedRowIndex === -1 ? 0 : selectedRowIndex,
    align: selectedRowIndex === -1 ? "start" : "center",
    behavior: "auto",
  };
  const listKey = `${openVersion}:${
    hasQuery ? trimmedQuery : "browse"
  }:${selectedRowIndex}`;

  const handleOpenChange = useCallback((next: boolean): void => {
    setOpen(next);
    setQueryState("");
    setActiveEntryId("");
    if (next) {
      suppressTriggerFocusRef.current = false;
      setOpenVersion((version) => version + 1);
    }
  }, []);

  const selectEntry = useCallback(
    (entry: PickerEntry): void => {
      if (pickerEntryDisabled(entry)) return;
      if (entry.kind === "pinned") {
        entry.option.onSelect();
      } else if (entry.kind === "result") {
        onSelectRow(entry.row);
      } else {
        entry.action.onSelect();
      }
      suppressTriggerFocusRef.current = true;
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectRow],
  );

  const scrollEntryIntoView = useCallback((entry: PickerEntry): void => {
    if (entry.kind !== "result") return;
    listRef.current?.scrollIntoView({
      index: entry.rowIndex,
      behavior: "auto",
    });
  }, []);

  const moveActiveEntry = useCallback(
    (direction: 1 | -1): void => {
      if (selectableEntries.length === 0) return;
      const currentIndex = selectableEntries.findIndex(
        (entry) => entry.id === effectiveActiveEntryId,
      );
      const fallbackIndex = direction > 0 ? -1 : selectableEntries.length;
      const nextIndex = clampIndex(
        (currentIndex === -1 ? fallbackIndex : currentIndex) + direction,
        selectableEntries.length,
      );
      const nextEntry = selectableEntries.at(nextIndex);
      if (nextEntry === undefined) return;
      setActiveEntryId(nextEntry.id);
      scrollEntryIntoView(nextEntry);
    },
    [effectiveActiveEntryId, scrollEntryIntoView, selectableEntries],
  );

  const activateEntryIndex = useCallback(
    (index: number): void => {
      const nextEntry = selectableEntries.at(index);
      if (nextEntry === undefined) return;
      setActiveEntryId(nextEntry.id);
      scrollEntryIntoView(nextEntry);
    },
    [scrollEntryIntoView, selectableEntries],
  );

  const resetQuery = useCallback((): void => {
    setQueryState("");
  }, []);

  const handleContentKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActiveEntry(1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActiveEntry(-1);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        activateEntryIndex(0);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        activateEntryIndex(selectableEntries.length - 1);
        return;
      }

      if (event.key === "Enter") {
        if (activeEntry === null) return;
        event.preventDefault();
        selectEntry(activeEntry);
        return;
      }

      if (event.key === "Escape" && hasQuery) {
        event.preventDefault();
        resetQuery();
      }
    },
    [
      activeEntry,
      activateEntryIndex,
      hasQuery,
      moveActiveEntry,
      resetQuery,
      selectableEntries.length,
      selectEntry,
    ],
  );

  const handleCloseAutoFocus = useCallback((event: Event): void => {
    if (!suppressTriggerFocusRef.current) return;
    suppressTriggerFocusRef.current = false;
    event.preventDefault();
  }, []);

  const setQuery = useCallback((nextQuery: string): void => {
    setQueryState(nextQuery);
  }, []);

  return {
    open,
    handleOpenChange,
    contentProps: {
      actions,
      align,
      contentClassName,
      effectiveActiveEntryId,
      emptyLabel,
      filteredRows,
      handleCloseAutoFocus,
      handleContentKeyDown,
      hasQuery,
      idPrefix,
      initialTopMostItemIndex,
      inputRef,
      listboxId,
      listboxLabel,
      listKey,
      listRef,
      open,
      pinnedRows,
      portalContainer,
      query,
      resetQuery,
      searchPlaceholder,
      selectEntry,
      setActiveEntryId,
      setQuery,
      side,
    },
  };
}
