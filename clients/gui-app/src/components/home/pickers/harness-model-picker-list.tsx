import {
  Virtuoso,
  type IndexLocationWithAlign,
  type VirtuosoHandle,
} from "react-virtuoso";
import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { HarnessModelPickerItem } from "@/components/home/pickers/harness-model-picker-item";
import { ModelRowsState } from "@/components/home/pickers/harness-model-picker-empty";
import type { ReactNode, RefObject } from "react";

interface HarnessModelPickerListProps {
  readonly idPrefix: string;
  readonly listboxId: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly listKey: string;
  readonly rows: ReadonlyArray<HarnessModelRow>;
  readonly selectedRowId: string;
  readonly activeRowId: string;
  readonly hoveredRowId: string;
  readonly hasQuery: boolean;
  readonly initialTopMostItemIndex: IndexLocationWithAlign;
  readonly catalogLoading: boolean;
  readonly catalogError: boolean;
  readonly activeProvider: GuiHarnessCatalogEntry | null;
  readonly onHover: (rowId: string) => void;
  readonly onActive: (rowId: string) => void;
  readonly onSelect: (row: HarnessModelRow) => void;
  readonly onOpenProviderSettings: () => void;
}

export function HarnessModelPickerList(
  props: HarnessModelPickerListProps,
): ReactNode {
  const {
    idPrefix,
    listboxId,
    listRef,
    listKey,
    rows,
    selectedRowId,
    activeRowId,
    hoveredRowId,
    hasQuery,
    initialTopMostItemIndex,
    catalogLoading,
    catalogError,
    activeProvider,
    onHover,
    onActive,
    onSelect,
    onOpenProviderSettings,
  } = props;

  const stateRow = ModelRowsState({
    catalogLoading,
    catalogError,
    hasQuery,
    activeProvider,
    rowsCount: rows.length,
    onOpenProviderSettings,
  });

  if (stateRow !== null) {
    return (
      <div
        id={listboxId}
        role="listbox"
        aria-label={modelListboxLabel(hasQuery)}
        className="h-full overflow-y-auto overscroll-contain p-1"
      >
        {stateRow}
      </div>
    );
  }

  return (
    <Virtuoso<undefined>
      key={listKey}
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={modelListboxLabel(hasQuery)}
      className="h-full overscroll-contain"
      computeItemKey={(index) => rows.at(index)?.id ?? index}
      defaultItemHeight={44}
      increaseViewportBy={120}
      initialItemCount={Math.min(rows.length, 12)}
      initialTopMostItemIndex={initialTopMostItemIndex}
      totalCount={rows.length}
      // eslint-disable-next-line react/no-unstable-nested-components
      itemContent={(index) => {
        const row = rows.at(index);
        if (row === undefined) return null;
        const previous = index > 0 ? rows.at(index - 1) : null;
        const groupHeader = providerGroupHeader(row, previous ?? null);
        return (
          <div className="px-1 py-0.5">
            {groupHeader === null ? null : (
              <ProviderGroupHeader label={groupHeader} />
            )}
            <HarnessModelPickerItem
              idPrefix={idPrefix}
              row={row}
              selected={row.id === selectedRowId}
              active={row.id === activeRowId}
              showCapacity={row.id === activeRowId || row.id === hoveredRowId}
              onHover={onHover}
              onActive={onActive}
              onSelect={onSelect}
            />
          </div>
        );
      }}
    />
  );
}

function modelListboxLabel(hasQuery: boolean): string {
  if (hasQuery) return "Model search results";
  return "Provider models";
}

/**
 * Provider label to render above `row`, or `null` when no header belongs here.
 * Headers appear in both browse and (harness-scoped) search results, at the
 * boundary where a row's provider group (keyed by the stable `providerGroupId`,
 * not the display label) differs from the row above it - so each contiguous
 * OpenCode provider run gets exactly one header. Two providers sharing a
 * display name still get separate headers because the boundary uses the stable
 * provider id. Non-grouped harnesses carry `providerGroupId === null` and never
 * show one.
 */
function providerGroupHeader(
  row: HarnessModelRow,
  previous: HarnessModelRow | null,
): string | null {
  if (row.providerGroupId === null) return null;
  if (previous !== null && previous.providerGroupId === row.providerGroupId) {
    return null;
  }
  return row.providerGroupLabel;
}

function ProviderGroupHeader(props: { readonly label: string }): ReactNode {
  return (
    <div
      role="presentation"
      className="px-2 pb-1 pt-2 text-overline font-medium uppercase text-muted-foreground/70"
    >
      {props.label}
    </div>
  );
}
