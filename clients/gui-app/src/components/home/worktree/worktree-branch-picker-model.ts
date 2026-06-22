import type { KeyboardEvent, ReactNode, RefObject } from "react";
import type { IndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";
import type { WorktreeBranchSearchRow } from "@/components/home/data/worktree-branch-search";

export interface WorktreeBranchPickerRow extends WorktreeBranchSearchRow {
  readonly value: string;
  readonly primaryLabel: string;
  readonly secondaryLabel: string | null;
  readonly secondaryTitle: string | null;
  readonly badges: ReadonlyArray<string>;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly testId: string | null;
}

export interface WorktreeBranchPickerPinnedRow {
  readonly id: string;
  readonly value: string;
  readonly primaryLabel: string;
  readonly secondaryLabel: string | null;
  readonly secondaryTitle: string | null;
  readonly badges: ReadonlyArray<string>;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly testId: string | null;
  readonly onSelect: () => void;
}

export interface WorktreeBranchPickerAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly testId: string | null;
  readonly onSelect: () => void;
}

export interface WorktreeBranchPickerProps {
  readonly trigger: ReactNode;
  readonly rows: ReadonlyArray<WorktreeBranchPickerRow>;
  readonly pinnedRows: ReadonlyArray<WorktreeBranchPickerPinnedRow>;
  readonly actions: ReadonlyArray<WorktreeBranchPickerAction>;
  readonly searchPlaceholder: string;
  readonly listboxLabel: string;
  readonly emptyLabel: string;
  readonly align: "start" | "center" | "end";
  readonly side: "top" | "right" | "bottom" | "left";
  /** Seeds the picker open on mount (no trigger click needed). */
  readonly defaultOpen: boolean;
  readonly contentClassName: string | undefined;
  readonly portalContainer: HTMLElement | null;
  readonly onSelectRow: (row: WorktreeBranchPickerRow) => void;
}

export type PickerEntry =
  | {
      readonly kind: "pinned";
      readonly id: string;
      readonly option: WorktreeBranchPickerPinnedRow;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly row: WorktreeBranchPickerRow;
      readonly rowIndex: number;
    }
  | {
      readonly kind: "action";
      readonly id: string;
      readonly action: WorktreeBranchPickerAction;
    };

export interface WorktreeBranchPickerController {
  readonly open: boolean;
  readonly handleOpenChange: (next: boolean) => void;
  readonly contentProps: WorktreeBranchPickerContentProps;
}

export interface WorktreeBranchPickerContentProps {
  readonly actions: ReadonlyArray<WorktreeBranchPickerAction>;
  readonly align: "start" | "center" | "end";
  readonly contentClassName: string | undefined;
  readonly effectiveActiveEntryId: string;
  readonly emptyLabel: string;
  readonly filteredRows: ReadonlyArray<WorktreeBranchPickerRow>;
  readonly hasQuery: boolean;
  readonly idPrefix: string;
  readonly initialTopMostItemIndex: IndexLocationWithAlign;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly listboxId: string;
  readonly listboxLabel: string;
  readonly listKey: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly open: boolean;
  readonly pinnedRows: ReadonlyArray<WorktreeBranchPickerPinnedRow>;
  readonly portalContainer: HTMLElement | null;
  readonly query: string;
  readonly searchPlaceholder: string;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly handleCloseAutoFocus: (event: Event) => void;
  readonly handleContentKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly resetQuery: () => void;
  readonly selectEntry: (entry: PickerEntry) => void;
  readonly setActiveEntryId: (entryId: string) => void;
  readonly setQuery: (query: string) => void;
}

export function pickerEntryId(kind: PickerEntry["kind"], id: string): string {
  return `${kind}:${id}`;
}

export function pickerElementId(idPrefix: string, entryId: string): string {
  return `${idPrefix}-entry-${entryId.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;
}

export function pickerEntryDisabled(entry: PickerEntry): boolean {
  if (entry.kind === "pinned") return entry.option.disabled;
  if (entry.kind === "result") return entry.row.disabled;
  return entry.action.disabled;
}

function pickerEntrySelected(entry: PickerEntry): boolean {
  if (entry.kind === "pinned") return entry.option.selected;
  if (entry.kind === "result") return entry.row.selected;
  return entry.action.selected;
}

export function fallbackEntryId(entries: ReadonlyArray<PickerEntry>): string {
  const selectedEntry = entries.find((entry) => pickerEntrySelected(entry));
  return selectedEntry?.id ?? entries.at(0)?.id ?? "";
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
