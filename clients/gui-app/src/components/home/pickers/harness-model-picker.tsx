import { useStore } from "zustand";

import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Kbd } from "@/components/ui/kbd";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import {
  findReasoningOptionsForModel,
  type HarnessOption,
  type ModelOption,
  type ProviderId,
} from "@/components/home/data/landing-options";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { commitSelection } from "@/stores/composer/commit-selection";
import {
  useGuiHarnessCatalog,
  useGuiHarnessModelsQuery,
  useGuiHarnessesQuery,
  useRefreshHarnessCatalog,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  buildAllHarnessModelRows,
  createModelRowSearchIndex,
  filterModelRows,
  flattenModelRowSections,
  sectionModelRowsByProviderRank,
  selectedModelRowId,
  type HarnessModelRow,
} from "@/components/home/data/harness-model-search";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  useCallback,
  useEffect,
  useId,
  memo,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import { HarnessModelPickerPanel } from "@/components/home/pickers/harness-model-picker-panel";
import { useHarnessModelPickerState } from "@/components/home/pickers/harness-model-picker-state";
import {
  railHarnessDegraded,
  visibleRailHarnesses,
} from "@/components/home/pickers/harness-rail-providers";
import { usePickerLeaderScope } from "@/components/home/pickers/use-picker-leader-scope";
import { handleHarnessModelPickerKeyDown } from "@/components/home/pickers/harness-model-picker-keyboard";
import { deriveHarnessModelPickerPresentation } from "@/components/home/pickers/harness-model-picker-presentation";
import type {
  ReasoningFooterConfig,
  ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { useRegisterActiveModelPicker } from "@/hooks/command-palette/use-register-active-model-picker";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerIdToGuiHarnessId,
  sortGuiHarnessesByProviderOrder,
} from "@/lib/provider-ordering";

export type { ReasoningFooterConfig, ServiceTierFooterConfig };

const EMPTY_MODELS: ReadonlyArray<ModelOption> = [];
const EMPTY_DEGRADED_HARNESS_IDS: ReadonlySet<GuiHarnessId> = new Set();

interface HarnessModelPickerProps {
  /** Per-composer toolbar store; the picker subscribes to the selection /
   *  reasoning / service-tier slices and dispatches through its actions. */
  store: ComposerToolbarStore;
  /**
   * Render the Fast-mode (service tier) footer. Chat surfaces show it; the
   * terminal launcher hides it (no service tier on TUI launches).
   */
  withServiceTier: boolean;
  /**
   * When true, the provider rail and model rows are restricted to TUI-capable
   * harnesses (the terminal-launch surface), hiding GUI-only providers like
   * `traycer`. `false` shows every GUI harness (chat surfaces).
   */
  tuiOnly: boolean;
  lockedHarnessId: ProviderId | null;
  disabled: boolean;
  /**
   * When true, this picker registers as the active composer's toggle target
   * (the `composer.model-picker.toggle` shortcut + the palette's "Change model…"
   * command act on it) while its surface is active and it isn't disabled. The
   * main composer toolbar and the terminal launcher pass `true`; fork / add-node
   * dialog pickers pass `false` so the global shortcut never targets them.
   */
  registerActivation: boolean;
}

function HarnessModelPickerImpl(props: HarnessModelPickerProps) {
  const {
    store,
    withServiceTier,
    tuiOnly,
    lockedHarnessId,
    disabled,
    registerActivation,
  } = props;
  const activityEnabled = useSurfaceActivity();
  const selection = useStore(store, (s) => s.selection);
  const selectedModel = useStore(store, (s) => s.selectedModel);
  const reasoning = useStore(store, (s) => s.reasoning);
  const serviceTier = useStore(store, (s) => s.serviceTier);
  const setReasoning = useStore(store, (s) => s.setReasoning);
  const setServiceTier = useStore(store, (s) => s.setServiceTier);
  // The footer configs were previously assembled (identically) by both the
  // chat toolbar and the terminal launcher; the picker is their only consumer,
  // so they are derived here in one place.
  const reasoningOptions = useMemo(
    () => findReasoningOptionsForModel(selectedModel),
    [selectedModel],
  );
  const reasoningFooter = useMemo<ReasoningFooterConfig>(
    () => ({
      value: reasoning,
      options: reasoningOptions,
      disabled: selectedModel !== null && reasoningOptions.length === 0,
      onChange: setReasoning,
    }),
    [reasoning, reasoningOptions, selectedModel, setReasoning],
  );
  // Service-tier preference is intentionally NOT normalized here. The store's
  // `serviceTier` is the user's sticky preference; the wire filter lives in
  // the codex-adapter at thread/start. Normalizing in the UI would race the
  // models query AND cause remembered composer settings to overwrite the
  // preference with the wire value.
  const serviceTierFooter = useMemo<ServiceTierFooterConfig | null>(
    () =>
      withServiceTier
        ? {
            selectedModel,
            value: serviceTier,
            onChange: setServiceTier,
          }
        : null,
    [selectedModel, serviceTier, setServiceTier, withServiceTier],
  );
  const idPrefix = useId();
  const listboxId = `${idPrefix}-model-listbox`;
  const {
    query,
    activeProviderId,
    activeRowId,
    hoveredRowId,
    openVersion,
    visibleOpen,
    handleOpenChange,
    handleQueryChange,
    setActiveProviderId,
    setActiveRowId,
    setHoveredRowId,
    closeOnly,
  } = useHarnessModelPickerState(selection.harnessId, disabled);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const { openSettings } = useSystemTabModalActions();
  const openProviderSettings = useCallback(() => {
    closeOnly();
    openSettings({
      section: "providers",
      resetToGeneral: false,
    });
  }, [closeOnly, openSettings]);

  useEffect(() => {
    if (activityEnabled || !visibleOpen) return;
    closeOnly();
  }, [activityEnabled, closeOnly, visibleOpen]);

  const harnessesQuery = useGuiHarnessesQuery({
    enabled: activityEnabled,
    subscribed: activityEnabled,
  });
  const providersQuery = useProvidersList({
    enabled: activityEnabled,
    subscribed: activityEnabled,
  });
  const degradedHarnessIds = useMemo(
    () =>
      providersQuery.data === undefined
        ? EMPTY_DEGRADED_HARNESS_IDS
        : degradedHarnessIdsFromProviderStates(providersQuery.data.providers),
    [providersQuery.data],
  );
  const harnesses = useMemo(
    () =>
      activityEnabled && harnessesQuery.data !== undefined
        ? orderModelPickerHarnesses(
            restrictToTui(harnessesQuery.data.harnesses, tuiOnly),
            degradedHarnessIds,
          )
        : [],
    [activityEnabled, degradedHarnessIds, harnessesQuery.data, tuiOnly],
  );
  const selectedHarness = harnesses.find(
    (harness) => harness.id === selection.harnessId,
  );
  const selectedModelsQuery = useGuiHarnessModelsQuery(
    selection.harnessId,
    null,
    {
      enabled: activityEnabled && selectedHarness?.available === true,
      subscribed: activityEnabled,
    },
  );
  const catalogActive = activityEnabled && visibleOpen;
  const catalog = useGuiHarnessCatalog(null, {
    enabled: catalogActive,
    subscribed: catalogActive,
  });
  // In terminal mode the rail/rows only offer TUI-capable harnesses; GUI-only
  // providers (e.g. `traycer`) are filtered out of the catalog up front so every
  // derived structure (active provider, rows, rail) inherits the restriction.
  const catalogHarnesses = useMemo(
    () =>
      orderModelPickerHarnesses(
        restrictToTui(catalog.harnesses, tuiOnly),
        degradedHarnessIds,
      ),
    [catalog.harnesses, degradedHarnessIds, tuiOnly],
  );
  const refreshCatalog = useRefreshHarnessCatalog();
  const selectedModels = selectedModelsQuery.data?.models ?? EMPTY_MODELS;
  const selectedHarnessAvailable = selectedHarness?.available === true;
  const presentation = useMemo(
    () =>
      deriveHarnessModelPickerPresentation({
        selection,
        models: selectedModels,
        reasoningFooter,
        serviceTierFooter,
        harnessesPending: harnessesQuery.isPending,
        modelsPending: selectedModelsQuery.isPending,
        selectedHarnessAvailable,
      }),
    [
      harnessesQuery.isPending,
      reasoningFooter,
      selectedHarnessAvailable,
      selectedModels,
      selectedModelsQuery.isPending,
      selection,
      serviceTierFooter,
    ],
  );
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  const resolvedActiveProviderId = useMemo(
    () =>
      lockedHarnessId ??
      resolveActiveProviderId(
        catalogHarnesses,
        activeProviderId,
        selection.harnessId,
        degradedHarnessIds,
      ),
    [
      activeProviderId,
      catalogHarnesses,
      degradedHarnessIds,
      lockedHarnessId,
      selection.harnessId,
    ],
  );
  const activeProvider =
    catalogHarnesses.find(
      (harness) => harness.id === resolvedActiveProviderId,
    ) ?? null;
  const rows = useMemo(
    () =>
      buildAllHarnessModelRows(
        catalogHarnesses.flatMap((harness) =>
          harness.available ? [{ harness, models: harness.models }] : [],
        ),
      ),
    [catalogHarnesses],
  );
  const providerRows = useMemo(
    () => rows.filter((row) => row.harnessId === resolvedActiveProviderId),
    [resolvedActiveProviderId, rows],
  );
  const providerSearchIndex = useMemo(
    () => createModelRowSearchIndex(providerRows),
    [providerRows],
  );
  const visibleRows = useMemo(() => {
    if (!hasQuery) return providerRows;
    return flattenModelRowSections(
      sectionModelRowsByProviderRank(
        filterModelRows(providerRows, providerSearchIndex, query),
      ),
    );
  }, [hasQuery, providerRows, providerSearchIndex, query]);
  const visibleRowsById = useMemo(
    () => new Map(visibleRows.map((row) => [row.id, row])),
    [visibleRows],
  );
  const selectedRowId = useMemo(
    () => selectedModelRowId(selection, rows),
    [rows, selection],
  );
  const { effectiveActiveRowId, initialTopMostItemIndex } = resolveRowAnchors({
    visibleRows,
    visibleRowsById,
    selectedRowId,
    activeRowId,
    hasQuery,
  });
  const activeRow = visibleRowsById.get(effectiveActiveRowId) ?? null;
  const listKey = modelRowsListKey({
    openVersion,
    hasQuery,
    query: trimmedQuery,
    activeProviderId: resolvedActiveProviderId,
  });
  const selectRow = useCallback(
    (row: HarnessModelRow) => {
      if (disabled) {
        closeOnly();
        return;
      }
      // Commit the picked model through the memory-aware funnel (restores that
      // (harness, model)'s remembered effort/tier, or the model's defaults).
      // Selecting a model keeps the picker open; it only closes on an outside
      // click / escape (handled by Popover's onOpenChange -> closeOnly).
      commitSelection(store, row.harnessId, row.value);
    },
    [closeOnly, disabled, store],
  );
  const handleProviderChange = useCallback(
    (providerId: ProviderId) => {
      // Locked fork (terminal): the harness is immovable - never switch off it.
      if (lockedHarnessId !== null && providerId !== lockedHarnessId) return;
      // Only an AVAILABLE, non-degraded provider commits a switch (restoring its
      // remembered model/effort/tier). A degraded / unavailable provider just
      // browses the rail - the panel shows its reauth / setup CTA, no commit.
      const harness =
        catalogHarnesses.find((option) => option.id === providerId) ??
        harnesses.find((option) => option.id === providerId) ??
        null;
      if (
        harness !== null &&
        harness.available &&
        !railHarnessDegraded(harness, degradedHarnessIds)
      ) {
        commitSelection(store, providerId, null);
      }
      setActiveProviderId(providerId);
    },
    [
      catalogHarnesses,
      degradedHarnessIds,
      harnesses,
      lockedHarnessId,
      setActiveProviderId,
      store,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      handleHarnessModelPickerKeyDown(event, {
        visibleRows,
        effectiveActiveRowId,
        activeRow,
        trimmedQuery,
        listRef,
        onActiveRowId: setActiveRowId,
        onSelectRow: selectRow,
        onQueryChange: handleQueryChange,
        onClose: closeOnly,
      });
    },
    [
      activeRow,
      closeOnly,
      effectiveActiveRowId,
      handleQueryChange,
      selectRow,
      setActiveRowId,
      trimmedQuery,
      visibleRows,
    ],
  );

  useEffect(() => {
    if (!visibleOpen) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [visibleOpen]);

  // Leader-key scope: while open, ⌘+digit switches the browsed provider rail
  // (suppressing epic-tab switching) and ⌥+digit sets the thinking level. The
  // ordered rail list mirrors what `ProviderRail` renders so digits line up with
  // the badges. Both handlers are pure state writes, so the search input keeps
  // focus and the user can keep typing after switching.
  const railHarnesses = useMemo(
    () => visibleRailHarnesses(catalogHarnesses, harnesses, degradedHarnessIds),
    [catalogHarnesses, degradedHarnessIds, harnesses],
  );
  // ⌥-reasoning is armed whenever the selected model exposes thinking levels.
  // The footer always reflects the selected model (not the browsed rail), so
  // ⌥+digit sets that model's level even while ⌘ browses a different provider.
  const reasoningActionable =
    reasoningFooter.options.length > 0 && !reasoningFooter.disabled;
  usePickerLeaderScope({
    open: visibleOpen,
    railHarnesses,
    onProviderChange: handleProviderChange,
    reasoning: reasoningFooter,
    reasoningActionable,
  });

  // Active-composer registration: while this picker's surface is active and it
  // isn't disabled, expose its open/close toggle + current-selection summary to
  // the `composer.model-picker.toggle` shortcut and the palette's "Change model…"
  // command. `registerActivation` keeps fork / add-node dialog pickers out; the
  // registration hook ref-parks the controller, so per-render identity churn is
  // harmless.
  const modelPickerChord = useBindingForAction("composer.model-picker.toggle");
  const activationController = useMemo(
    () => ({
      toggle: () => handleOpenChange(!visibleOpen),
      getSelectionSummary: () =>
        modelPickerSelectionSummary(
          presentation.label,
          presentation.reasoningLabel,
        ),
    }),
    [handleOpenChange, visibleOpen, presentation],
  );
  useRegisterActiveModelPicker(
    registerActivation && activityEnabled && !disabled,
    activationController,
  );

  const tooltipLabel = (
    <span className="flex items-center gap-2">
      <span className="truncate">{presentation.label}</span>
      {modelPickerChord !== null ? (
        <Kbd className="text-code-xs">
          {formatChordForDisplay(modelPickerChord)}
        </Kbd>
      ) : null}
    </span>
  );

  return (
    <Popover open={visibleOpen} onOpenChange={handleOpenChange}>
      <TooltipWrapper
        label={tooltipLabel}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <HarnessModelTrigger
            selection={selection}
            label={presentation.label}
            reasoningLabel={presentation.reasoningLabel}
            serviceTierLabel={presentation.activeServiceTierLabel}
            serviceTierActive={presentation.serviceTierActive}
            isLoading={presentation.isLoading}
            disabled={disabled}
          />
        </PopoverTrigger>
      </TooltipWrapper>
      <HarnessModelPickerPanel
        trimmedQuery={trimmedQuery}
        hasQuery={hasQuery}
        listboxId={listboxId}
        idPrefix={idPrefix}
        inputRef={inputRef}
        query={query}
        onQueryChange={handleQueryChange}
        activeProviderLabel={activeProvider?.label ?? ""}
        activeDescendant={modelRowActiveDescendant(idPrefix, activeRow)}
        onKeyDown={handleKeyDown}
        catalogHarnesses={catalogHarnesses}
        fallbackHarnesses={harnesses}
        resolvedActiveProviderId={resolvedActiveProviderId}
        lockedHarnessId={lockedHarnessId}
        degradedHarnessIds={degradedHarnessIds}
        catalogHarnessesLoading={catalog.harnessesLoading}
        onProviderChange={handleProviderChange}
        onRefreshCatalog={refreshCatalog}
        onOpenProviderSettings={openProviderSettings}
        listRef={listRef}
        listKey={listKey}
        visibleRows={visibleRows}
        selectedRowId={selectedRowId}
        effectiveActiveRowId={effectiveActiveRowId}
        hoveredRowId={hoveredRowId}
        initialTopMostItemIndex={initialTopMostItemIndex}
        catalogHarnessesError={catalog.harnessesError !== null}
        activeProvider={activeProvider}
        onHoverRow={setHoveredRowId}
        onActiveRow={setActiveRowId}
        onSelectRow={selectRow}
        reasoningFooter={reasoningFooter}
        serviceTierFooter={serviceTierFooter}
      />
    </Popover>
  );
}

export const HarnessModelPicker = memo(HarnessModelPickerImpl);

// Short current-selection summary for the palette's "Change model…" subtitle.
// Null while the model label is still resolving so the row shows no stale copy.
function modelPickerSelectionSummary(
  label: string,
  reasoningLabel: string | null,
): string | null {
  if (label.length === 0) return null;
  if (reasoningLabel === null) return label;
  return `${label} · Thinking ${reasoningLabel}`;
}

// Restrict to harnesses whose adapter advertises a TUI surface. This is the
// runtime capability (`modes`), not the schema id: Cursor is a TUI harness at
// the schema level but its adapter currently advertises only `gui`, so it stays
// hidden from the terminal launcher until the CLI ships - and reappears on its
// own once the host starts advertising `tui`, with no code change here.
function isTuiCapable(harness: HarnessOption): boolean {
  return harness.modes.includes("tui");
}

// Narrow a harness list to the TUI-capable subset when `tuiOnly`, else pass it
// through. Shared by the rail/fallback and catalog derivations so the filter
// rule lives in one place. Generic so it preserves catalog-entry subtypes.
function restrictToTui<T extends HarnessOption>(
  harnesses: ReadonlyArray<T>,
  tuiOnly: boolean,
): ReadonlyArray<T> {
  return tuiOnly ? harnesses.filter(isTuiCapable) : harnesses;
}

function orderModelPickerHarnesses<T extends HarnessOption>(
  harnesses: ReadonlyArray<T>,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): ReadonlyArray<T> {
  return sortGuiHarnessesByProviderOrder(harnesses).toSorted(
    (left, right) =>
      Number(railHarnessDegraded(left, degradedHarnessIds)) -
      Number(railHarnessDegraded(right, degradedHarnessIds)),
  );
}

function degradedHarnessIdsFromProviderStates(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlySet<GuiHarnessId> {
  return new Set(
    providers.flatMap((provider) =>
      providerNeedsPickerReauth(provider)
        ? [providerIdToGuiHarnessId(provider.providerId)]
        : [],
    ),
  );
}

function providerNeedsPickerReauth(provider: ProviderCliState): boolean {
  return (
    provider.enabled &&
    (provider.auth.status === "unauthenticated" ||
      (provider.apiKey.supported && !provider.apiKey.configured))
  );
}

function resolveActiveProviderId(
  harnesses: ReadonlyArray<HarnessOption>,
  activeProviderId: ProviderId,
  selectedProviderId: ProviderId,
  degradedHarnessIds: ReadonlySet<GuiHarnessId>,
): ProviderId {
  const selectable = (harness: HarnessOption): boolean =>
    harness.available || railHarnessDegraded(harness, degradedHarnessIds);
  if (
    harnesses.some(
      (harness) => harness.id === activeProviderId && selectable(harness),
    )
  ) {
    return activeProviderId;
  }
  if (
    harnesses.some(
      (harness) => harness.id === selectedProviderId && selectable(harness),
    )
  ) {
    return selectedProviderId;
  }
  return harnesses.find(selectable)?.id ?? activeProviderId;
}

interface ResolveRowAnchorsInput {
  readonly visibleRows: ReadonlyArray<HarnessModelRow>;
  readonly visibleRowsById: ReadonlyMap<string, HarnessModelRow>;
  readonly selectedRowId: string;
  readonly activeRowId: string;
  readonly hasQuery: boolean;
}

interface ResolveRowAnchorsResult {
  readonly effectiveActiveRowId: string;
  readonly initialTopMostItemIndex: {
    index: number;
    align: "center" | "end" | "start";
    behavior: "auto";
  };
}

function resolveRowAnchors(
  input: ResolveRowAnchorsInput,
): ResolveRowAnchorsResult {
  const { visibleRows, visibleRowsById, selectedRowId, activeRowId, hasQuery } =
    input;
  // While searching, anchor on the top (best) match: scroll to the start and
  // pre-highlight the first result so Enter selects it. `activeRowId` is reset
  // on every keystroke (see `handleQueryChange`), so it only holds a value here
  // when the user has explicitly arrowed through the current result set.
  if (hasQuery) {
    const firstRowId = visibleRows.at(0)?.id ?? "";
    return {
      effectiveActiveRowId: visibleRowsById.has(activeRowId)
        ? activeRowId
        : firstRowId,
      initialTopMostItemIndex: { index: 0, align: "start", behavior: "auto" },
    };
  }
  const selectedRowVisible = visibleRowsById.has(selectedRowId);
  const selectedRowIndex = selectedRowVisible
    ? visibleRows.findIndex((row) => row.id === selectedRowId)
    : -1;
  const fallbackActiveRowId =
    (selectedRowVisible ? selectedRowId : visibleRows.at(0)?.id) ?? "";
  const effectiveActiveRowId = visibleRowsById.has(activeRowId)
    ? activeRowId
    : fallbackActiveRowId;
  return {
    effectiveActiveRowId,
    initialTopMostItemIndex: {
      index: selectedRowIndex === -1 ? 0 : selectedRowIndex,
      align: selectedRowIndex === -1 ? "start" : "center",
      behavior: "auto",
    },
  };
}

function modelRowActiveDescendant(
  idPrefix: string,
  row: HarnessModelRow | null,
): string | undefined {
  if (row === null) return undefined;
  return `${idPrefix}-row-${row.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

interface ModelRowsListKeyInput {
  readonly openVersion: number;
  readonly hasQuery: boolean;
  readonly query: string;
  readonly activeProviderId: ProviderId;
}

// Note: `selectedRowId` is deliberately NOT part of the key. Selecting a model
// only flips a row's `selected` highlight (prop-driven, no remount) and updates
// the footer. Scroll-to-selected on open is handled by `openVersion` busting the
// key, so baking selection in here would remount the whole Virtuoso list on
// every pick while the picker stays open.
function modelRowsListKey(input: ModelRowsListKeyInput): string {
  const { openVersion, hasQuery, query, activeProviderId } = input;
  const modeKey = hasQuery
    ? `search:${activeProviderId}:${query}`
    : `browse:${activeProviderId}`;
  return `${openVersion}:${modeKey}`;
}
