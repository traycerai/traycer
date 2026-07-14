import { useStore } from "zustand";

import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Kbd } from "@/components/ui/kbd";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import {
  findUpgradeServiceTierForModel,
  findReasoningOptionsForModel,
  type HarnessOption,
  type ModelOption,
  type ProviderId,
} from "@/components/home/data/landing-options";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { commitSelection } from "@/stores/composer/commit-selection";
import {
  harnessCatalogEntryNeedsRefresh,
  useDefaultHostClient,
  useGuiHarnessCatalog,
  useGuiHarnessCommandsQuery,
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
  type ReactNode,
} from "react";
import { HarnessModelPickerPanel } from "@/components/home/pickers/harness-model-picker-panel";
import { useHarnessModelPickerState } from "@/components/home/pickers/harness-model-picker-state";
import {
  railHarnessDegraded,
  resolveActiveProfileForHarness,
  visibleRailEntries,
} from "@/components/home/pickers/harness-rail-providers";
import {
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
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
import {
  useProvidersList,
  useProvidersListForClient,
} from "@/hooks/providers/use-providers-list-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  EMPTY_LOGIN_CAPABILITY_BY_HARNESS_ID,
  loginCapabilityByHarnessIdFromProviderStates,
  resolveCreateProfileGate,
  useCreateProfileHostIsLocal,
} from "@/components/home/pickers/harness-model-picker-create-profile-gate";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerIdToGuiHarnessId,
  sortGuiHarnessesByProviderOrder,
} from "@/lib/provider-ordering";

export type { ReasoningFooterConfig, ServiceTierFooterConfig };

const EMPTY_MODELS: ReadonlyArray<ModelOption> = [];
// No working directory is scoped to the picker surface itself - this feeds
// the commands prewarm query below, where an empty set is the correct shape
// (see the comment at its call site).
const EMPTY_COMMANDS_WORKING_DIRECTORIES: ReadonlyArray<string> = [];
const EMPTY_DEGRADED_HARNESS_IDS: ReadonlySet<GuiHarnessId> = new Set();
const EMPTY_PROFILES_BY_HARNESS_ID: ReadonlyMap<
  GuiHarnessId,
  ReadonlyArray<ProviderProfile>
> = new Map();

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
  /**
   * The host "Create new profile" creates on - the id of the picker's owning
   * tab, or `null` when this picker isn't bound to any tab yet (landing
   * composer, add-node dropdown), meaning the app-wide default host applies.
   * A tab-bound surface (the chat composer, fork dialogs) MUST pass its own
   * tab's host id here: the add-profile flow mounts globally, outside any
   * `<TabHostProvider>`, so without this it would silently create the
   * profile against the renderer-default host even when the composer itself
   * runs turns on a different one (the tab-host-binding rule).
   */
  createProfileHostId: string | null;
}

function HarnessModelPickerImpl(props: HarnessModelPickerProps) {
  const {
    store,
    withServiceTier,
    tuiOnly,
    lockedHarnessId,
    disabled,
    registerActivation,
    createProfileHostId,
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
    activeProfileId,
    activeRowId,
    hoveredRowId,
    openVersion,
    visibleOpen,
    handleOpenChange,
    handleQueryChange,
    setActiveRailEntry,
    setActiveRowId,
    setHoveredRowId,
    closeOnly,
  } = useHarnessModelPickerState(
    selection.harnessId,
    selection.profileId,
    disabled,
  );
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
  const profilesByHarnessId = useMemo(
    () =>
      providersQuery.data === undefined
        ? EMPTY_PROFILES_BY_HARNESS_ID
        : profilesByHarnessIdFromProviderStates(providersQuery.data.providers),
    [providersQuery.data],
  );
  // The create-profile gate's capability data must come from the SAME host
  // the add-profile flow will target - `ProviderProfileAddFlowHost` resolves
  // its client from this exact prop via `useHostClientForHostId`, not the
  // app-wide default host `providersQuery` above serves the rail/dropdown/
  // degraded state from. A tab bound to a different host would otherwise let
  // the pre-click gate disagree with the host that receives
  // `providers.startLogin`.
  const createProfileClient = useHostClientForHostId(createProfileHostId);
  const createProfileProvidersQuery = useProvidersListForClient(
    createProfileClient,
    { enabled: activityEnabled, subscribed: activityEnabled },
  );
  const loginCapabilityByHarnessId = useMemo(
    () =>
      createProfileProvidersQuery.data === undefined
        ? EMPTY_LOGIN_CAPABILITY_BY_HARNESS_ID
        : loginCapabilityByHarnessIdFromProviderStates(
            createProfileProvidersQuery.data.providers,
          ),
    [createProfileProvidersQuery.data],
  );
  const createProfileHostIsLocal =
    useCreateProfileHostIsLocal(createProfileHostId);
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
  const selectedHarnessAvailable = selectedHarness?.available === true;
  // Shared gate for every intent-edge refetch below (models AND the commands
  // prewarm): mirrors `selectedModelsQuery`'s own `enabled`. TanStack's
  // imperative `.refetch()` ignores `enabled` - it runs the queryFn
  // regardless - so an unguarded refetch here would still spawn a server (or
  // hit a disabled provider's `listModels`/`listCommands`) for a harness the
  // user disabled or that isn't available. `harness-runtime.ts`'s
  // `prewarmCatalog` re-checks provider enablement for the same reason.
  const selectedHarnessRefetchGate =
    activityEnabled && selectedHarnessAvailable;
  const selectedModelsQuery = useGuiHarnessModelsQuery(
    selection.harnessId,
    null,
    {
      enabled: selectedHarnessRefetchGate,
      subscribed: activityEnabled,
    },
  );
  // Traycer and OpenRouter fetch their model catalogs over remote HTTP, so
  // `selectedModelsQuery` never touches their managed OpenCode server - only
  // `listCommands` (or chat) does. The intent edges below therefore also
  // refetch this harness's commands purely to prewarm that server; the
  // returned catalog itself is unused here (the composer owns rendering
  // commands). The picker isn't scoped to any working directory, and an empty
  // `workingDirectories` still reaches the adapter/server - every adapter's
  // `listCommands` falls back to a single `{ workingDirectory: null }`
  // request when given none - so it's the simplest correct shape for a
  // prewarm-only call.
  //
  // Held permanently disabled (and unsubscribed - nothing here renders its
  // result) so the ONLY thing that can ever fire it is the guarded
  // `runSelectedHarnessIntentRefetch` below. `enabled: true` would let
  // TanStack fetch it on mount and on other automatic triggers - i.e. spawn a
  // provider's server outside an intent edge and outside that guard.
  // `.refetch()` ignores `enabled` (the same quirk the guard exists to
  // contain), so the intent edges still drive it.
  const defaultHostClient = useDefaultHostClient();
  const selectedCommandsQuery = useGuiHarnessCommandsQuery(
    defaultHostClient,
    selection.harnessId,
    EMPTY_COMMANDS_WORKING_DIRECTORIES,
    {
      enabled: false,
      subscribed: false,
    },
  );
  // Latest-ref indirection: a `UseQueryResult` is a fresh object every render,
  // and `selectedHarnessRefetchGate` must be read at the moment the intent
  // effects below actually fire rather than captured as a stale closure from
  // whenever `visibleOpen` / `selection.harnessId` last changed - so none of
  // these is a dependency of those effects. Adding the gate as a dependency
  // would re-run them on every gate flip, not just on an actual open/selection
  // edge. This effect has no dependency array, so it re-syncs after every
  // render and is declared BEFORE the intent effects: React runs effects in
  // declaration order, so on the render where the user picks a new harness the
  // refs already point at that harness's query by the time the selection edge
  // fires.
  const selectedModelsQueryRef = useRef(selectedModelsQuery);
  const selectedCommandsQueryRef = useRef(selectedCommandsQuery);
  const selectedHarnessRefetchGateRef = useRef(selectedHarnessRefetchGate);
  useEffect(() => {
    selectedModelsQueryRef.current = selectedModelsQuery;
    selectedCommandsQueryRef.current = selectedCommandsQuery;
    selectedHarnessRefetchGateRef.current = selectedHarnessRefetchGate;
  });
  // Shared by both intent effects below - a stable identity (empty deps) so
  // listing it as an effect dependency never itself retriggers them. Kept as
  // its own function (rather than inlined) so the guards are a single source of
  // truth and don't duplicate into both effect bodies.
  //
  // Each query is asked separately whether it is due, rather than sharing one
  // verdict: models are seeded by the app-load prefetch while the commands
  // prewarm is only ever fired from here, so a shared verdict keyed on models
  // would leave a Traycer/OpenRouter server un-prewarmed for the whole first
  // window (their models come from remote HTTP and never touch it - only
  // `listCommands` does).
  const runSelectedHarnessIntentRefetch = useCallback(() => {
    if (!selectedHarnessRefetchGateRef.current) return;
    const models = selectedModelsQueryRef.current;
    if (harnessCatalogEntryNeedsRefresh(models)) void models.refetch();
    const commands = selectedCommandsQueryRef.current;
    if (harnessCatalogEntryNeedsRefresh(commands)) void commands.refetch();
  }, []);
  // Explicit intent edges, and the ONLY thing that refreshes a model catalog
  // outside the app-load fill and the manual refresh button - every model query
  // is cache-only now (see `use-gui-harness-catalog.ts`). They refresh just the
  // selected harness, so opening the picker no longer fans out across every
  // provider, and only once its cached entry has aged past the window, so an
  // open on warm cache costs nothing. That also makes them the intent-driven
  // prewarm for a reaped OpenCode-backed server (the age threshold is the
  // host's idle timeout) and the error-recovery path, now that a failed fetch
  // no longer self-heals on a background timer.
  useEffect(() => {
    if (!visibleOpen) return;
    runSelectedHarnessIntentRefetch();
  }, [runSelectedHarnessIntentRefetch, visibleOpen]);
  const skipInitialHarnessRefetchRef = useRef(true);
  useEffect(() => {
    if (skipInitialHarnessRefetchRef.current) {
      skipInitialHarnessRefetchRef.current = false;
      return;
    }
    runSelectedHarnessIntentRefetch();
  }, [runSelectedHarnessIntentRefetch, selection.harnessId]);
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
        selectedHarnessProfiles:
          profilesByHarnessId.get(selection.harnessId) ?? [],
      }),
    [
      harnessesQuery.isPending,
      profilesByHarnessId,
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
  // Mirrors Settings' `providerCanStartProfileOauth` gate: OAuth sign-in
  // needs a local host that advertises login args for the browsed provider.
  // A tab-bound composer gates on the TAB's host locality (`createProfileHostIsLocal`,
  // resolved from `createProfileHostId`), never the renderer-default host.
  const createProfileGate = resolveCreateProfileGate(
    createProfileHostIsLocal,
    loginCapabilityByHarnessId.get(resolvedActiveProviderId),
  );
  const activeProvider =
    catalogHarnesses.find(
      (harness) => harness.id === resolvedActiveProviderId,
    ) ?? null;
  // The profile browsed/selected within the active provider: prefer the
  // reducer's `activeProfileId` (a strip click or ⌘-digit rail switch) if it
  // belongs to this harness, else the committed selection's profile if it
  // belongs to this harness, else the harness's first selectable profile.
  // `null` (and no strip) under 2 profiles.
  const activePanelProfileId = useMemo(
    () =>
      resolveActiveProfileForHarness(
        profilesByHarnessId.get(resolvedActiveProviderId) ?? [],
        activeProfileId,
        selection.harnessId === resolvedActiveProviderId
          ? selection.profileId
          : null,
      ),
    [
      activeProfileId,
      profilesByHarnessId,
      resolvedActiveProviderId,
      selection.harnessId,
      selection.profileId,
    ],
  );
  // Falls back to the fallback harness list's label while the catalog hasn't
  // resolved the active provider yet (e.g. still loading).
  const activePanelLabel = useMemo(
    () =>
      activeProvider?.label ??
      harnesses.find((harness) => harness.id === resolvedActiveProviderId)
        ?.label ??
      "",
    [activeProvider, harnesses, resolvedActiveProviderId],
  );
  // Profiles the active provider's strip renders (provisional/mid-OAuth
  // profiles filtered out) - under 2 means no strip and no rail dot.
  const activeProviderProfiles = useMemo(
    () => profilesByHarnessId.get(resolvedActiveProviderId) ?? [],
    [profilesByHarnessId, resolvedActiveProviderId],
  );
  // Which profile each harness's rail dot reflects: the active provider's
  // browsed profile, plus the composer's already-committed selection's
  // profile when browsing a DIFFERENT provider (so its dot doesn't silently
  // reset to the ambient default while it's off screen). Every other harness
  // falls back to its own first selectable profile inside `visibleRailEntries`.
  const activeProfileIdByHarnessId = useMemo(() => {
    const map = new Map<GuiHarnessId, string | null>([
      [resolvedActiveProviderId, activePanelProfileId],
    ]);
    if (selection.harnessId !== resolvedActiveProviderId) {
      map.set(selection.harnessId, selection.profileId);
    }
    return map;
  }, [
    activePanelProfileId,
    resolvedActiveProviderId,
    selection.harnessId,
    selection.profileId,
  ]);
  // Rail entries: one per visible provider (see `visibleRailEntries`); the
  // rail no longer splits by profile - that lives in the profile dropdown.
  const railEntries = useMemo(
    () =>
      visibleRailEntries({
        harnesses: catalogHarnesses,
        fallbackHarnesses: harnesses,
        degradedHarnessIds,
        profilesByHarnessId,
        activeProfileIdByHarnessId,
      }),
    [
      activeProfileIdByHarnessId,
      catalogHarnesses,
      degradedHarnessIds,
      harnesses,
      profilesByHarnessId,
    ],
  );
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
      // (harness, profile, model)'s remembered effort/tier, or the model's
      // defaults). Selecting a model keeps the picker open; it only closes on
      // an outside click / escape (handled by Popover's onOpenChange ->
      // closeOnly).
      commitSelection(store, row.harnessId, row.value, activePanelProfileId);
    },
    [activePanelProfileId, closeOnly, disabled, store],
  );
  const handleRailEntryChange = useCallback(
    (providerId: ProviderId) => {
      // Locked fork (terminal): the harness is immovable - never switch off it.
      if (lockedHarnessId !== null && providerId !== lockedHarnessId) return;
      // The rail only ever targets a PROVIDER now (profile switching lives in
      // the strip) - resolve which profile browsing this provider should
      // land on: the reducer's already-browsed profile if it's still this
      // provider's (a same-provider re-click / no-op), else the committed
      // selection's profile if this provider is already selected, else the
      // provider's first selectable profile.
      const resolvedProfileId = resolveActiveProfileForHarness(
        profilesByHarnessId.get(providerId) ?? [],
        providerId === activeProviderId ? activeProfileId : null,
        providerId === selection.harnessId ? selection.profileId : null,
      );
      // Only an AVAILABLE, non-degraded entry commits a switch (restoring its
      // remembered model/effort/tier). A degraded / unavailable entry just
      // browses the rail - the panel shows its reauth / setup CTA, no commit.
      const entry = railEntries.find(
        (candidate) => candidate.harness.id === providerId,
      );
      if (entry !== undefined && entry.harness.available && !entry.degraded) {
        commitSelection(store, providerId, null, resolvedProfileId);
      }
      setActiveRailEntry(providerId, resolvedProfileId);
    },
    [
      activeProfileId,
      activeProviderId,
      lockedHarnessId,
      profilesByHarnessId,
      railEntries,
      selection.harnessId,
      selection.profileId,
      setActiveRailEntry,
      store,
    ],
  );
  const handleProfileChange = useCallback(
    (providerId: ProviderId, profileId: string | null) => {
      // Mirrors `handleRailEntryChange`'s lock rule: while a fork lock is
      // active the strip stays interactive for the locked provider only.
      if (lockedHarnessId !== null && providerId !== lockedHarnessId) return;
      commitSelection(store, providerId, null, profileId);
      setActiveRailEntry(providerId, profileId);
    },
    [lockedHarnessId, setActiveRailEntry, store],
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

  // Leader-key scope: while open, ⌘+digit switches the browsed rail entry
  // (suppressing epic-tab switching) and ⌥+digit sets the thinking level.
  // `railEntries` mirrors what `ProviderRail` renders so digits line up with
  // the badges. Both handlers are pure state writes, so the search input keeps
  // focus and the user can keep typing after switching.
  // ⌥-reasoning is armed whenever the selected model exposes thinking levels.
  // The footer always reflects the selected model (not the browsed rail), so
  // ⌥+digit sets that model's level even while ⌘ browses a different provider.
  const reasoningActionable =
    reasoningFooter.options.length > 0 && !reasoningFooter.disabled;
  usePickerLeaderScope({
    open: visibleOpen,
    railEntries,
    onEntryChange: handleRailEntryChange,
    reasoning: reasoningFooter,
    reasoningActionable,
    activeProviderId: resolvedActiveProviderId,
    activeProviderProfiles,
    onProfileChange: handleProfileChange,
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

  const selectedHarnessLabel = selectedHarness?.label ?? selection.harnessId;
  const tooltipLabel = (
    <HarnessModelPickerTooltip
      harnessLabel={selectedHarnessLabel}
      modelLabel={presentation.label}
      reasoningLabel={presentation.reasoningLabel}
      fastModeLabel={fastModeTooltipLabel(serviceTierFooter, selectedModel)}
      profileLabel={profileTooltipLabel(
        profilesByHarnessId.get(selection.harnessId) ?? [],
        selection.profileId,
      )}
      shortcutLabel={
        modelPickerChord === null
          ? null
          : formatChordForDisplay(modelPickerChord)
      }
    />
  );

  return (
    <Popover open={visibleOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <TooltipWrapper
          label={tooltipLabel}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <HarnessModelTrigger
            selection={selection}
            label={presentation.label}
            reasoningLabel={presentation.reasoningLabel}
            serviceTierLabel={presentation.activeServiceTierLabel}
            serviceTierActive={presentation.serviceTierActive}
            profileLabel={presentation.profileLabel}
            profileAccentDot={presentation.profileAccentDot}
            isLoading={presentation.isLoading}
            disabled={disabled}
          />
        </TooltipWrapper>
      </PopoverTrigger>
      <HarnessModelPickerPanel
        trimmedQuery={trimmedQuery}
        hasQuery={hasQuery}
        listboxId={listboxId}
        idPrefix={idPrefix}
        inputRef={inputRef}
        query={query}
        onQueryChange={handleQueryChange}
        activeProviderLabel={activePanelLabel}
        activeDescendant={modelRowActiveDescendant(idPrefix, activeRow)}
        onKeyDown={handleKeyDown}
        catalogHarnesses={catalogHarnesses}
        fallbackHarnesses={harnesses}
        profilesByHarnessId={profilesByHarnessId}
        resolvedActiveProviderId={resolvedActiveProviderId}
        activeProfileId={activePanelProfileId}
        activeProfileIdByHarnessId={activeProfileIdByHarnessId}
        activeProviderProfiles={activeProviderProfiles}
        lockedHarnessId={lockedHarnessId}
        degradedHarnessIds={degradedHarnessIds}
        catalogHarnessesLoading={catalog.harnessesLoading}
        onEntryChange={handleRailEntryChange}
        onProfileChange={handleProfileChange}
        onRefreshCatalog={refreshCatalog}
        onOpenProviderSettings={openProviderSettings}
        onClosePicker={closeOnly}
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
        createProfileHostId={createProfileHostId}
        createProfileDisabled={createProfileGate.disabled}
        createProfileDisabledReason={createProfileGate.reason}
      />
    </Popover>
  );
}

export const HarnessModelPicker = memo(HarnessModelPickerImpl);

function HarnessModelPickerTooltip({
  harnessLabel,
  modelLabel,
  reasoningLabel,
  fastModeLabel,
  profileLabel,
  shortcutLabel,
}: {
  readonly harnessLabel: string;
  readonly modelLabel: string;
  readonly reasoningLabel: string | null;
  readonly fastModeLabel: string | null;
  readonly profileLabel: string | null;
  readonly shortcutLabel: string | null;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-left">
      <div className="truncate font-medium">{modelLabel}</div>
      <TooltipSummaryRow label="Harness" value={harnessLabel} />
      {reasoningLabel === null ? null : (
        <TooltipSummaryRow label="Effort" value={reasoningLabel} />
      )}
      {fastModeLabel === null ? null : (
        <TooltipSummaryRow label="Fast" value={fastModeLabel} />
      )}
      {profileLabel === null ? null : (
        <TooltipSummaryRow label="Profile" value={profileLabel} />
      )}
      {shortcutLabel === null ? null : (
        <div className="mt-0.5 flex min-w-0 items-center justify-between gap-3 border-t border-background/15 pt-1">
          <span className="text-background/70">Shortcut</span>
          <Kbd className="text-code-xs">{shortcutLabel}</Kbd>
        </div>
      )}
    </div>
  );
}

function TooltipSummaryRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="shrink-0 text-background/70">{label}</span>
      <span className="min-w-0 truncate font-medium">{value}</span>
    </div>
  );
}

function fastModeTooltipLabel(
  serviceTierFooter: ServiceTierFooterConfig | null,
  selectedModel: ModelOption | null,
): string | null {
  if (serviceTierFooter === null) return null;
  const upgrade = findUpgradeServiceTierForModel(selectedModel);
  if (upgrade === null) return null;
  const active = serviceTierFooter.value === upgrade.id;
  return `${upgrade.label} ${active ? "on" : "off"}`;
}

function profileTooltipLabel(
  profiles: ReadonlyArray<ProviderProfile>,
  selectedProfileId: string | null,
): string | null {
  if (profiles.length < 2) return null;
  const activeProfile =
    profiles.find(
      (profile) => profileCommitId(profile) === selectedProfileId,
    ) ?? profiles.at(0);
  if (activeProfile === undefined) return null;
  return profileDisplayLabel(activeProfile);
}

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

function profilesByHarnessIdFromProviderStates(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyMap<GuiHarnessId, ReadonlyArray<ProviderProfile>> {
  return new Map(
    providers.map((provider) => [
      providerIdToGuiHarnessId(provider.providerId),
      provider.profiles,
    ]),
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
