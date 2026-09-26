import {
  Virtuoso,
  type IndexLocationWithAlign,
  type VirtuosoHandle,
} from "react-virtuoso";
import type { HarnessModelPickerRow } from "@/components/home/data/harness-model-search";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { HarnessModelPickerItem } from "@/components/home/pickers/harness-model-picker-item";
import { SuggestionItem } from "@/components/home/pickers/harness-model-picker-suggestion-item";
import { ModelRowsState } from "@/components/home/pickers/harness-model-picker-empty";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { Fragment, type ReactNode, type RefObject } from "react";

interface HarnessModelPickerListProps {
  readonly idPrefix: string;
  readonly listboxId: string;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly listKey: string;
  readonly rows: ReadonlyArray<HarnessModelPickerRow>;
  /**
   * What the injected section's heading item renders, or `null` when the
   * picker has no injected rows (every composer surface).
   */
  readonly suggestionHeading: ReactNode | null;
  readonly selectedRowId: string;
  readonly activeRowId: string;
  readonly hoveredRowId: string;
  readonly hasQuery: boolean;
  readonly initialTopMostItemIndex: IndexLocationWithAlign;
  readonly catalogLoading: boolean;
  readonly catalogError: boolean;
  readonly hostUnavailableLabel: string | null;
  readonly activeProvider: GuiHarnessCatalogEntry | null;
  readonly activeProviderState: ProviderCliState | null;
  readonly onHover: (rowId: string) => void;
  readonly onActive: (rowId: string) => void;
  readonly onSelect: (row: HarnessModelPickerRow) => void;
  readonly onOpenProviderSettings: (focusTab: string) => void;
  readonly terminalLoginSurface: ProviderTerminalLoginSurface | null;
  readonly runTargetHostId: string | null;
  readonly onClosePicker: () => void;
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
    suggestionHeading,
    selectedRowId,
    activeRowId,
    hoveredRowId,
    hasQuery,
    initialTopMostItemIndex,
    catalogLoading,
    catalogError,
    hostUnavailableLabel,
    activeProvider,
    activeProviderState,
    onHover,
    onActive,
    onSelect,
    onOpenProviderSettings,
    terminalLoginSurface,
    runTargetHostId,
    onClosePicker,
  } = props;

  const stateRow = ModelRowsState({
    catalogLoading,
    catalogError,
    hostUnavailableLabel,
    hasQuery,
    activeProvider,
    activeProviderState,
    // The provider's OWN rows decide its empty/loading state; injected rows
    // are not models of the browsed provider.
    rowsCount: rows.filter((row) => row.kind === "model").length,
    onOpenProviderSettings,
    terminalLoginSurface,
    runTargetHostId,
    onClosePicker,
  });

  const renderRow = (
    row: HarnessModelPickerRow,
    previous: HarnessModelPickerRow | null,
  ): ReactNode => {
    switch (row.kind) {
      case "suggestion-heading":
        return (
          <div role="presentation" className="px-1 pb-1 pt-1">
            {suggestionHeading}
          </div>
        );
      case "suggestion":
        return (
          <div className="px-1 py-0.5">
            <SuggestionItem
              idPrefix={idPrefix}
              row={row}
              selected={row.id === selectedRowId}
              active={row.id === activeRowId}
              onHover={onHover}
              onActive={onActive}
              onSelect={onSelect}
            />
          </div>
        );
      case "model": {
        const groupHeader = providerGroupHeader(row, previous);
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
              // The tagged row, not the item's bare one, so the picker's select
              // handler can branch on `kind`.
              onSelect={() => {
                onSelect(row);
              }}
            />
          </div>
        );
      }
    }
  };

  if (stateRow !== null) {
    // The provider's own state (loading, unavailable, empty) replaces its
    // model rows, never the injected ones above them: a destination offered
    // on another provider is still offered while this one loads.
    const injected = rows.filter((row) => row.kind !== "model");
    return (
      <div
        id={listboxId}
        role="listbox"
        aria-label={modelListboxLabel(hasQuery)}
        className="h-full overflow-y-auto overscroll-contain p-1"
      >
        {injected.map((row) => (
          <Fragment key={row.id}>{renderRow(row, null)}</Fragment>
        ))}
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
        return renderRow(row, previous ?? null);
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
  row: Extract<HarnessModelPickerRow, { kind: "model" }>,
  previous: HarnessModelPickerRow | null,
): string | null {
  if (row.providerGroupId === null) return null;
  if (
    previous !== null &&
    previous.kind === "model" &&
    previous.providerGroupId === row.providerGroupId
  ) {
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
