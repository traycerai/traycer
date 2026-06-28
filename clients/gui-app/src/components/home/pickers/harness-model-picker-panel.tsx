import { PopoverContent } from "@/components/ui/popover";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { LEADER_SCOPE_MODEL_PICKER } from "@/lib/keybindings/leader-scope";
import { HarnessModelPickerSearch } from "@/components/home/pickers/harness-model-picker-search";
import { HarnessModelPickerList } from "@/components/home/pickers/harness-model-picker-list";
import { ProviderRail } from "@/components/home/pickers/harness-model-picker-group";
import type {
  HarnessOption,
  ProviderId,
} from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import type { VirtuosoHandle } from "react-virtuoso";
import type { KeyboardEvent, RefObject } from "react";
import {
  HarnessModelPickerModelSettingsFooter,
  type ReasoningFooterConfig,
  type ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";

interface HarnessModelPickerPanelProps {
  readonly trimmedQuery: string;
  readonly hasQuery: boolean;
  readonly listboxId: string;
  readonly idPrefix: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly activeProviderLabel: string;
  readonly activeDescendant: string | undefined;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly catalogHarnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly resolvedActiveProviderId: ProviderId;
  readonly lockedHarnessId: ProviderId | null;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly catalogHarnessesLoading: boolean;
  readonly onProviderChange: (providerId: ProviderId) => void;
  readonly onRefreshCatalog: () => Promise<void>;
  readonly onOpenProviderSettings: () => void;
  readonly listRef: RefObject<VirtuosoHandle | null>;
  readonly listKey: string;
  readonly visibleRows: ReadonlyArray<HarnessModelRow>;
  readonly selectedRowId: string;
  readonly effectiveActiveRowId: string;
  readonly hoveredRowId: string;
  readonly initialTopMostItemIndex: {
    index: number;
    align: "center" | "end" | "start";
    behavior: "auto";
  };
  readonly catalogHarnessesError: boolean;
  readonly activeProvider: GuiHarnessCatalogEntry | null;
  readonly onHoverRow: (rowId: string) => void;
  readonly onActiveRow: (rowId: string) => void;
  readonly onSelectRow: (row: HarnessModelRow) => void;
  readonly reasoningFooter: ReasoningFooterConfig | null;
  readonly serviceTierFooter: ServiceTierFooterConfig | null;
}

export function HarnessModelPickerPanel(props: HarnessModelPickerPanelProps) {
  const {
    trimmedQuery,
    hasQuery,
    listboxId,
    idPrefix,
    inputRef,
    query,
    onQueryChange,
    activeProviderLabel,
    activeDescendant,
    onKeyDown,
    catalogHarnesses,
    fallbackHarnesses,
    resolvedActiveProviderId,
    lockedHarnessId,
    degradedHarnessIds,
    catalogHarnessesLoading,
    onProviderChange,
    onRefreshCatalog,
    onOpenProviderSettings,
    listRef,
    listKey,
    visibleRows,
    selectedRowId,
    effectiveActiveRowId,
    hoveredRowId,
    initialTopMostItemIndex,
    catalogHarnessesError,
    activeProvider,
    onHoverRow,
    onActiveRow,
    onSelectRow,
    reasoningFooter,
    serviceTierFooter,
  } = props;

  return (
    <PopoverContent
      side="bottom"
      align="end"
      sideOffset={8}
      collisionPadding={12}
      role="dialog"
      aria-label="Select model"
      // Opts this popover out of the keybinding provider's dialog block so the
      // picker's leader-digit shortcuts fire while it's open (see
      // `isAnyDialogOpen` in keybinding-provider.tsx).
      data-leader-scope={LEADER_SCOPE_MODEL_PICKER}
      className="h-[min(var(--radix-popover-content-available-height),23rem)] w-[min(86vw,30rem)] gap-0 overflow-hidden rounded-xl p-0"
      // Return focus to the composer editor (not the trigger pill) on close so
      // the user can keep typing after picking a model. No-op on surfaces with
      // no registered composer (e.g. the terminal launcher), where Radix's
      // default focus restore stands.
      onCloseAutoFocus={(event) => {
        if (focusActiveComposer()) event.preventDefault();
      }}
      onKeyDown={onKeyDown}
      onEscapeKeyDown={(event) => {
        if (trimmedQuery.length === 0) return;
        event.preventDefault();
        onQueryChange("");
      }}
    >
      <HarnessModelPickerSearch
        inputRef={inputRef}
        value={query}
        onChange={onQueryChange}
        providerLabel={activeProviderLabel}
        listboxId={listboxId}
        activeDescendant={activeDescendant}
      />
      {/* The provider rail stays mounted while searching: search is local to the
          active harness, so the rail keeps its role as the only way to switch
          scope. The grid is always two columns - no width jump on query. */}
      <div className="grid min-h-0 flex-1 grid-cols-[3rem_minmax(0,1fr)] overflow-hidden">
        <ProviderRail
          harnesses={catalogHarnesses}
          fallbackHarnesses={fallbackHarnesses}
          activeProviderId={resolvedActiveProviderId}
          lockedHarnessId={lockedHarnessId}
          degradedHarnessIds={degradedHarnessIds}
          pending={catalogHarnessesLoading}
          onProviderChange={onProviderChange}
          onRefresh={onRefreshCatalog}
          onOpenProviderSettings={onOpenProviderSettings}
        />
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden">
            <HarnessModelPickerList
              idPrefix={idPrefix}
              listboxId={listboxId}
              listRef={listRef}
              listKey={listKey}
              rows={visibleRows}
              selectedRowId={selectedRowId}
              activeRowId={effectiveActiveRowId}
              hoveredRowId={hoveredRowId}
              hasQuery={hasQuery}
              initialTopMostItemIndex={initialTopMostItemIndex}
              catalogLoading={catalogHarnessesLoading}
              catalogError={catalogHarnessesError}
              activeProvider={activeProvider}
              onHover={onHoverRow}
              onActive={onActiveRow}
              onSelect={onSelectRow}
              onOpenProviderSettings={onOpenProviderSettings}
            />
          </div>
          <HarnessModelPickerModelSettingsFooter
            reasoning={reasoningFooter}
            serviceTier={serviceTierFooter}
          />
        </div>
      </div>
    </PopoverContent>
  );
}
