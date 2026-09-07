import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  modelMatchIsCovered,
  modelsForHarness,
  resolveModelBySlug,
} from "@traycer/protocol/host/agent/gui/model-slug-resolution";

import {
  findDefaultModel,
  findSelectedModel,
  normalizePermissionMode,
  normalizeReasoningForModel,
  normalizeServiceTierForModel,
  type HarnessModelSelection,
  type HarnessOption,
  type ModelOption,
  type PermissionMode,
  type ProviderId,
  type ReasoningLevel,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/** Per-composer toolbar state (model/permission/reasoning/tier). */
export interface ComposerToolbarValues {
  readonly permission: PermissionMode;
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly serviceTier: ServiceTier;
}

export interface ComposerToolbarCatalog {
  /** The host this composer runs turns on - the same host the catalog below was fetched from. */
  readonly hostId: string | null;
  /** `undefined` while the harness list is loading / the surface is inactive. */
  readonly harnesses: ReadonlyArray<HarnessOption> | undefined;
  /** Harness the `models` list was fetched for. */
  readonly modelsHarnessId: ProviderId;
  readonly models: ReadonlyArray<ModelOption>;
  /** Whether the models query for `modelsHarnessId` has RESOLVED (as opposed to still loading). */
  readonly modelsLoaded: boolean;
  /** True when the consuming surface is the terminal launcher. */
  readonly tuiOnly: boolean;
}

interface ComposerToolbarDerived {
  /** Resolved selection: availability-rerouted harness + concrete model slug
   *  (empty only while the catalog is still resolving). */
  readonly selection: HarnessModelSelection;
  readonly selectedModel: ModelOption | null;
  /** Raw permission clamped to what the selected harness honors - the single
   *  clamp site for picker display AND emitted settings. */
  readonly permission: PermissionMode;
  readonly reasoning: ReasoningLevel;
  readonly serviceTier: ServiceTier;
  /** Permission modes the selected harness honors; `null` while the catalog
   *  is loading or the harness is unknown (picker keeps every option enabled). */
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  /** Display label of the selected harness, for picker copy. */
  readonly harnessLabel: string | null;
  /**
   * True only when the loaded catalog of the selected harness covers the resolved model slug - by
   * exact slug OR by alias, since a held alias is a valid runnable selection and not a dead one.
   */
  readonly selectionCatalogConfirmed: boolean;
}

export interface ComposerToolbarState extends ComposerToolbarDerived {
  readonly seedKey: string;
  readonly values: ComposerToolbarValues;
  readonly catalog: ComposerToolbarCatalog;
  readonly onSettingsChange: ((settings: ChatRunSettings) => void) | null;
  /** A user edit happened while the model slug was still unresolved (catalog loading). */
  readonly pendingSettingsEmit: boolean;
}

/**
 * The single `(harness, model)` commit funnel. Patches selection + reasoning + tier in one
 * `update()` (one derive, one emit), so a switch never sequences multiple emits.
 */
export interface ApplyComposerSelectionInput {
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly serviceTier: ServiceTier;
}

export interface ComposerToolbarActions {
  readonly setPermission: (next: PermissionMode) => void;
  readonly setSelection: (next: HarnessModelSelection) => void;
  readonly applyComposerSelection: (input: ApplyComposerSelectionInput) => void;
  readonly setReasoning: (next: ReasoningLevel) => void;
  readonly setServiceTier: (next: ServiceTier) => void;
  /**
   * Replace the raw values when the seed identity changes (draft swap, settings restored from
   * persistence).
   */
  readonly applySeed: (seedKey: string, values: ComposerToolbarValues) => void;
  /** Push fresh catalog data; flushes a deferred emit once the model resolves. */
  readonly setCatalog: (catalog: ComposerToolbarCatalog) => void;
  readonly setOnSettingsChange: (
    onSettingsChange: ((settings: ChatRunSettings) => void) | null,
  ) => void;
}

export type ComposerToolbarStoreState = ComposerToolbarState &
  ComposerToolbarActions;

export type ComposerToolbarStore = StoreApi<ComposerToolbarStoreState>;

const EMPTY_MODELS: ReadonlyArray<ModelOption> = [];

export interface CreateComposerToolbarStoreInput {
  readonly seedKey: string;
  readonly values: ComposerToolbarValues;
  readonly onSettingsChange: ((settings: ChatRunSettings) => void) | null;
  /** Seeds `catalog.tuiOnly`; kept in sync at runtime via `setCatalog`. */
  readonly tuiOnly: boolean;
  /** Seeds `catalog.hostId`; kept in sync at runtime via `setCatalog`. */
  readonly hostId: string | null;
}

export function createComposerToolbarStore(
  input: CreateComposerToolbarStoreInput,
): ComposerToolbarStore {
  const initialCatalog: ComposerToolbarCatalog = {
    hostId: input.hostId,
    harnesses: undefined,
    modelsHarnessId: input.values.selection.harnessId,
    models: EMPTY_MODELS,
    modelsLoaded: false,
    tuiOnly: input.tuiOnly,
  };
  return createStore<ComposerToolbarStoreState>((set, get) => {
    const update = (patch: Partial<ComposerToolbarValues>): void => {
      const state = get();
      const values = { ...state.values, ...patch };
      const derived = deriveToolbarState(values, state.catalog, state);
      const settings = settingsFromDerived(derived);
      // Never persist a surface-rerouted harness.
      const rerouted =
        derived.selection.harnessId !== values.selection.harnessId;
      // Defer only when the slug is still unresolved (catalog loading) or the harness was
      // surface-rerouted - the surface emit (live-settings/last-run) is NOT gated on catalog
      if (settings.model.length === 0 || rerouted) {
        set({ values, ...derived, pendingSettingsEmit: true });
        return;
      }
      set({ values, ...derived, pendingSettingsEmit: false });
      state.onSettingsChange?.(settings);
    };

    return {
      seedKey: input.seedKey,
      values: input.values,
      catalog: initialCatalog,
      ...deriveToolbarState(input.values, initialCatalog, null),
      onSettingsChange: input.onSettingsChange,
      pendingSettingsEmit: false,

      setPermission: (next) => {
        update({ permission: next });
      },
      // No permission clamp here: the derived `permission` clamps against the (possibly new) harness's
      // supported modes in one place, for display and emit alike.
      setSelection: (next) => {
        update({ selection: next });
      },
      // The combined commit path used by every memory-aware entry point.
      applyComposerSelection: ({ selection, reasoning, serviceTier }) => {
        const prev = get().values.selection.harnessId;
        if (prev !== selection.harnessId) {
          Analytics.getInstance().track(AnalyticsEvent.HarnessChanged, {
            from: prev,
            to: selection.harnessId,
          });
        }
        update({ selection, reasoning, serviceTier });
      },
      setReasoning: (next) => {
        update({ reasoning: next });
      },
      setServiceTier: (next) => {
        update({ serviceTier: next });
      },

      applySeed: (seedKey, values) => {
        const state = get();
        if (state.seedKey === seedKey) return;
        const derived = deriveToolbarState(values, state.catalog, state);
        set({
          seedKey,
          values,
          ...derived,
          // A new seed supersedes any edit queued under the previous one.
          pendingSettingsEmit: false,
        });
      },

      setCatalog: (catalog) => {
        const state = get();
        if (sameCatalog(state.catalog, catalog)) return;
        const derived = deriveToolbarState(state.values, catalog, state);
        // The emit/heal decision (the two intentionally-different raw-vs-derived
        // comparisons) lives in one named, testable place.
        const { emit, healedValues } = decideCatalogTransition(state, derived);
        set({
          catalog,
          values: healedValues,
          ...derived,
          // Only an emit clears the deferred flag; a silent push leaves it as-is.
          pendingSettingsEmit: emit ? false : state.pendingSettingsEmit,
        });
        if (emit) state.onSettingsChange?.(settingsFromDerived(derived));
      },

      setOnSettingsChange: (onSettingsChange) => {
        if (get().onSettingsChange === onSettingsChange) return;
        set({ onSettingsChange });
      },
    };
  });
}

function settingsFromDerived(derived: ComposerToolbarDerived): ChatRunSettings {
  return buildChatRunSettings({
    selection: derived.selection,
    permission: derived.permission,
    reasoning: derived.reasoning,
    // Already clamped to the selected model in `deriveToolbarState` (the single site shared with the
    // picker display); the codex-adapter still re-filters on the wire as defense-in-depth.
    serviceTier: derived.serviceTier,
  });
}

function deriveToolbarState(
  values: ComposerToolbarValues,
  catalog: ComposerToolbarCatalog,
  previous: ComposerToolbarDerived | null,
): ComposerToolbarDerived {
  const availabilitySelection = effectiveSelectionFromHarnesses(
    values.selection,
    catalog.harnesses,
    catalog.tuiOnly,
  );
  // Cross-harness guard: only resolve a model from the catalog when the model
  // list actually belongs to the harness we're presenting.
  const catalogBelongsToHarness =
    catalog.modelsHarnessId === availabilitySelection.harnessId;
  const models = catalogBelongsToHarness ? catalog.models : EMPTY_MODELS;
  // Loaded ONLY when this harness's own models query has resolved - sourced from the explicit
  // `modelsLoaded` status, never inferred from `models.length`, so a provider whose list loads empty
  const catalogLoadedForHarness =
    catalogBelongsToHarness && catalog.modelsLoaded;
  const resolvedSlug = resolveModelSlug(
    availabilitySelection.harnessId,
    availabilitySelection.modelSlug,
    models,
    catalogLoadedForHarness,
  );
  const selection: HarnessModelSelection =
    resolvedSlug === availabilitySelection.modelSlug
      ? availabilitySelection
      : {
          harnessId: availabilitySelection.harnessId,
          modelSlug: resolvedSlug,
          profileId: availabilitySelection.profileId,
        };
  // True ONLY when the loaded catalog covers the resolved slug - by exact slug or by alias.
  const selectionCatalogConfirmed =
    catalogLoadedForHarness &&
    modelCoveredByCatalog(models, selection.harnessId, resolvedSlug);
  const selectedModel = findSelectedModel(models, selection);
  // Harness-level capabilities (currently just supportedPermissionModes) come from
  // `listGuiHarnesses`.
  const selectedHarness =
    catalog.harnesses?.find((harness) => harness.id === selection.harnessId) ??
    null;
  const supportedPermissionModes =
    selectedHarness?.supportedPermissionModes ?? null;
  const derived: ComposerToolbarDerived = {
    selection,
    selectedModel,
    permission: normalizePermissionMode(
      values.permission,
      supportedPermissionModes,
    ),
    reasoning: normalizeReasoningForModel(values.reasoning, selectedModel),
    // Clamp the sticky tier to the selected model (single site for display AND emit) so a tier carried
    // over from another model - e.g.
    serviceTier: normalizeServiceTierForModel(
      values.serviceTier,
      selectedModel,
    ),
    supportedPermissionModes,
    harnessLabel: selectedHarness?.label ?? null,
    selectionCatalogConfirmed,
  };
  // Preserve the previous `selection` reference when nothing changed so slice subscribers (picker,
  // send gate) don't wake on every catalog push.
  if (
    previous !== null &&
    previous.selection.harnessId === derived.selection.harnessId &&
    previous.selection.modelSlug === derived.selection.modelSlug &&
    previous.selection.profileId === derived.selection.profileId
  ) {
    return { ...derived, selection: previous.selection };
  }
  return derived;
}

/**
 * Decide, on a fresh catalog push, whether the resolved settings should EMIT to the surface and
 * whether the RAW sticky slug should be HEALED to the resolved one.
 */
function decideCatalogTransition(
  state: ComposerToolbarState,
  derived: ComposerToolbarDerived,
): { emit: boolean; healedValues: ComposerToolbarValues } {
  // Reroute guard: never emit while the derived harness is a surface clamp of
  // the user's choice, or the rerouted harness would leak into settings.
  const rerouted =
    derived.selection.harnessId !== state.values.selection.harnessId;
  // A catalog LOAD that resolves a previously-CONCRETE slug to a different concrete slug - the
  // delisted self-heal (a stale remembered slug X resolving to the first model Y) - must propagate
  const resolvedSlugSelfHealed =
    derived.selectionCatalogConfirmed &&
    state.selection.modelSlug.length > 0 &&
    derived.selection.modelSlug !== state.selection.modelSlug;
  const emit =
    !rerouted &&
    derived.selection.modelSlug.length > 0 &&
    (state.pendingSettingsEmit || resolvedSlugSelfHealed);
  if (!emit) return { emit: false, healedValues: state.values };
  // Heal the RAW sticky slug to the confirmed resolved one on a delisting (loaded catalog, raw slug
  // concretely absent, not rerouted), so later load/unload cycles don't keep re-deriving the X->Y
  const healedValues =
    derived.selectionCatalogConfirmed &&
    state.values.selection.modelSlug.length > 0 &&
    derived.selection.modelSlug !== state.values.selection.modelSlug
      ? {
          ...state.values,
          selection: {
            ...state.values.selection,
            modelSlug: derived.selection.modelSlug,
          },
        }
      : state.values;
  return { emit: true, healedValues };
}

function sameCatalog(
  a: ComposerToolbarCatalog,
  b: ComposerToolbarCatalog,
): boolean {
  return (
    // A host switch with an otherwise-identical (cached) catalog must still
    // land: `hostId` keys the memory reads/writes downstream of this store.
    a.hostId === b.hostId &&
    a.harnesses === b.harnesses &&
    a.modelsHarnessId === b.modelsHarnessId &&
    a.models === b.models &&
    // Must compare the load status: a pure loading -> loaded transition (e.g.
    a.modelsLoaded === b.modelsLoaded &&
    a.tuiOnly === b.tuiOnly
  );
}

// Whether the loaded catalog covers this slug by EITHER pass.
function modelCoveredByCatalog(
  models: ReadonlyArray<ModelOption>,
  harnessId: ProviderId,
  modelSlug: string,
): boolean {
  return modelMatchIsCovered(
    resolveModelBySlug(modelsForHarness(models, harnessId), modelSlug),
  );
}

// Resolve the concrete model slug the selection presents from a remembered / seeded slug that is
// NOT guaranteed to exist in the loaded catalog:
function resolveModelSlug(
  harnessId: ProviderId,
  modelSlug: string,
  models: ReadonlyArray<ModelOption>,
  catalogLoadedForHarness: boolean,
): string {
  if (modelSlug.length === 0) {
    return catalogLoadedForHarness
      ? (findDefaultModel(models)?.slug ?? "")
      : "";
  }
  const match = resolveModelBySlug(
    modelsForHarness(models, harnessId),
    modelSlug,
  );
  if (modelMatchIsCovered(match)) return modelSlug;
  if (!catalogLoadedForHarness) return modelSlug;
  return findDefaultModel(models)?.slug ?? "";
}

function effectiveSelectionFromHarnesses(
  selection: HarnessModelSelection,
  harnesses: ReadonlyArray<HarnessOption> | undefined,
  tuiOnly: boolean,
): HarnessModelSelection {
  if (harnesses === undefined) return selection;
  let firstEligible: HarnessOption | null = null;
  for (const harness of sortGuiHarnessesByProviderOrder(harnesses)) {
    // A harness whose availability probe is still in flight is NOT yet known to be unavailable.
    if (
      harness.id === selection.harnessId &&
      harness.availabilityPending &&
      (!tuiOnly || harness.modes.includes("tui"))
    ) {
      return selection;
    }
    if (!harness.available) continue;
    // On the terminal surface only TUI-capable harnesses are eligible, so a GUI-only selection carried
    // over from chat is rerouted off it - mirroring the availability reroute.
    if (tuiOnly && !harness.modes.includes("tui")) continue;
    firstEligible ??= harness;
    if (harness.id === selection.harnessId) return selection;
  }
  if (firstEligible === null) return selection;
  return { harnessId: firstEligible.id, modelSlug: "", profileId: null };
}
