import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import {
  findDefaultModel,
  findSelectedModel,
  normalizePermissionMode,
  normalizeReasoningForModel,
  normalizeServiceTierForModel,
  type AgentMode,
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

/**
 * Per-composer toolbar state (model/permission/reasoning/tier/agent-mode).
 *
 * One store instance is created per composer surface (held in `useState`,
 * mirroring `createComposerPickerStore`), so toggling model / provider /
 * reasoning for one chat never leaks into another. Toolbar leaves subscribe
 * to the derived slices they render; submit paths read `store.getState()` -
 * the sanctioned escape hatch - so the host composer component does not
 * re-render on toolbar changes at all.
 *
 * The store keeps two layers:
 *
 * - `values`: the RAW sticky values exactly as seeded/user-picked. They are
 *   never clamped, so a preference survives a harness/model round-trip.
 * - derived top-level fields (`selection`, `permission`, `reasoning`,
 *   `selectedModel`, `supportedPermissionModes`, ...): the resolved values
 *   the UI shows and the emit path sends. Recomputed by every action from
 *   `values` + `catalog`, with reference-preservation so unchanged slices
 *   don't wake subscribers.
 *
 * Catalog data (harness availability + the selected harness's models) is
 * TanStack Query state pushed in via `setCatalog` by
 * `useComposerToolbarStore`; this store never fetches.
 */
export interface ComposerToolbarValues {
  readonly permission: PermissionMode;
  readonly selection: HarnessModelSelection;
  readonly reasoning: ReasoningLevel;
  readonly serviceTier: ServiceTier;
  readonly agentMode: AgentMode;
}

export interface ComposerToolbarCatalog {
  /** `undefined` while the harness list is loading / the surface is inactive. */
  readonly harnesses: ReadonlyArray<HarnessOption> | undefined;
  /**
   * Harness the `models` list was fetched for. The models query is keyed on
   * the derived harness id, so during a harness switch a stale push must not
   * resolve a model slug for the wrong harness - derivation ignores `models`
   * unless this matches the effective selection's harness.
   */
  readonly modelsHarnessId: ProviderId;
  readonly models: ReadonlyArray<ModelOption>;
  /**
   * Whether the models query for `modelsHarnessId` has RESOLVED (as opposed to
   * still loading). Sourced from the query's own load state - never inferred
   * from `models.length` - so "loaded empty" is distinguishable from "loading":
   * a remembered slug is held verbatim for display while the catalog loads, and
   * only resolved to a fallback (or confirmed) once the catalog is proven
   * loaded. During a cross-harness switch the new harness's query is pending
   * until its own models land, so this is `false` for that window.
   */
  readonly modelsLoaded: boolean;
  /**
   * True when the consuming surface is the terminal launcher. A selection
   * carried over from a chat surface that isn't TUI-capable - GUI-only
   * `traycer`, or a schema-TUI harness like `cursor` whose adapter currently
   * advertises only `gui` - is then rerouted to the first available TUI-capable
   * harness, the same single clamp site that reroutes off an unavailable
   * harness. Chat surfaces push `false` and the selection is never narrowed by
   * surface, so flipping back to chat re-presents the raw sticky harness.
   */
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
  readonly agentMode: AgentMode;
  /** Permission modes the selected harness honors; `null` while the catalog
   *  is loading or the harness is unknown (picker keeps every option enabled). */
  readonly supportedPermissionModes: ReadonlyArray<PermissionMode> | null;
  /** Display label of the selected harness, for picker copy. */
  readonly harnessLabel: string | null;
  /**
   * True only when the resolved model slug is a real, loaded model of the
   * selected harness. The surface emit is NOT gated on this - live-settings /
   * last-run propagate immediately. It is the signal the memory-recording
   * wrapper reads at WRITE time, so an unvalidated or stale remembered slug -
   * sourced from memory, not a loaded list - is never written to memory before
   * the catalog proves it valid. An empty / unresolved slug is never a loaded
   * model, so is never confirmed.
   */
  readonly selectionCatalogConfirmed: boolean;
}

export interface ComposerToolbarState extends ComposerToolbarDerived {
  readonly seedKey: string;
  readonly values: ComposerToolbarValues;
  readonly catalog: ComposerToolbarCatalog;
  readonly onSettingsChange: ((settings: ChatRunSettings) => void) | null;
  /**
   * A user edit happened while the model slug was still unresolved (catalog
   * loading). The emit is deferred until `setCatalog` resolves a concrete
   * slug, so `model: ""` never reaches persistence or the wire.
   */
  readonly pendingSettingsEmit: boolean;
}

/**
 * The single `(harness, model)` commit funnel. Patches selection + reasoning +
 * tier in one `update()` (one derive, one emit), so a switch never sequences
 * multiple emits. The caller resolves `reasoning` / `serviceTier` from memory
 * before calling; `""` is the no-carry lever (the derive resolves it to the
 * selected model's own default).
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
  readonly setAgentMode: (next: AgentMode) => void;
  /**
   * Replace the raw values when the seed identity changes (draft swap,
   * settings restored from persistence). No-op when `seedKey` matches the
   * current one, so default-derived re-renders never clobber user edits.
   * Never emits.
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
}

export function createComposerToolbarStore(
  input: CreateComposerToolbarStoreInput,
): ComposerToolbarStore {
  const initialCatalog: ComposerToolbarCatalog = {
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
      // Never persist a surface-rerouted harness. When the derived harness
      // differs from the user's raw choice it was clamped by the surface
      // (terminal `tuiOnly` narrowing, or an unavailable-harness fallback) -
      // that clamp is display/launch-only, so emitting it would overwrite the
      // sticky harness the user actually picked. Hold the edit until the
      // derived harness matches the chosen one again (e.g. switching back to
      // chat, or the harness becoming available).
      const rerouted =
        derived.selection.harnessId !== values.selection.harnessId;
      // Defer only when the slug is still unresolved (catalog loading) or the
      // harness was surface-rerouted - the surface emit (live-settings/last-run)
      // is NOT gated on catalog confirmation. Memory integrity is enforced at the
      // write site (the recording wrapper reads `selectionCatalogConfirmed`), so
      // the toolbar still propagates a held remembered slug immediately.
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
      // No permission clamp here: the derived `permission` clamps against the
      // (possibly new) harness's supported modes in one place, for display
      // and emit alike. `HarnessChanged` analytics is NOT tracked here - every
      // UI harness change now commits via `applyComposerSelection` (which owns
      // the track); `setSelection` is the low-level setter for tests / internal
      // same-harness model edits only.
      setSelection: (next) => {
        update({ selection: next });
      },
      // The combined commit path used by every memory-aware entry point. A
      // single `update()` with all three values patched emits at most once - a
      // harness switch restores its remembered model/effort/tier (or the
      // model's own defaults via the `""` no-carry lever) without the multiple
      // emits that sequenced `setSelection`/`setReasoning`/`setServiceTier`
      // calls would produce. Owns the `HarnessChanged` analytics for this path.
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
      setAgentMode: (next) => {
        update({ agentMode: next });
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
    // Already clamped to the selected model in `deriveToolbarState` (the single
    // site shared with the picker display); the codex-adapter still re-filters
    // on the wire as defense-in-depth.
    serviceTier: derived.serviceTier,
    agentMode: derived.agentMode,
  });
}

function deriveToolbarState(
  values: ComposerToolbarValues,
  catalog: ComposerToolbarCatalog,
  previous: ComposerToolbarDerived | null,
): ComposerToolbarDerived {
  // If the active provider is unavailable (disabled in Settings, or its CLI
  // can't launch) - or, on the terminal surface, isn't TUI-capable - present
  // the first eligible one instead so a hidden/disabled/GUI-only provider is
  // never shown as selected or sent.
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
  // Loaded ONLY when this harness's own models query has resolved - sourced from
  // the explicit `modelsLoaded` status, never inferred from `models.length`, so
  // a provider whose list loads empty (resolve a fallback / hold the emit) is
  // distinguishable from one still loading (hold the slug for display).
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
      : { harnessId: availabilitySelection.harnessId, modelSlug: resolvedSlug };
  // True ONLY when the resolved slug is a real, loaded model of this harness.
  // The surface emit is NOT gated on this (live-settings propagate immediately);
  // it is the signal the `recordingOnSettingsChange` wrapper reads at write time
  // so an unvalidated / stale remembered slug is never written to memory before
  // the catalog proves it valid. Once loaded, the resolved FALLBACK slug
  // (delisted case) is what becomes confirmed, letting the memory write
  // self-heal a dead slug.
  const selectionCatalogConfirmed =
    catalogLoadedForHarness &&
    modelExists(models, selection.harnessId, resolvedSlug);
  const selectedModel = findSelectedModel(models, selection);
  // Harness-level capabilities (currently just supportedPermissionModes) come
  // from `listGuiHarnesses`. `null` covers both "catalog still loading" and
  // "selected harness id isn't in it"; `normalizePermissionMode`
  // short-circuits on null so neither state triggers a silent rewrite, and
  // the host-side `assertPermissionModeSupported` is the safety net in
  // that window.
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
    // Clamp the sticky tier to the selected model (single site for display AND
    // emit) so a tier carried over from another model - e.g. Codex "priority"
    // after a switch to Claude, whose upgrade tier is "fast" - is dropped here
    // instead of leaking onto the turn as a stale "Fast mode on".
    serviceTier: normalizeServiceTierForModel(
      values.serviceTier,
      selectedModel,
    ),
    agentMode: values.agentMode,
    supportedPermissionModes,
    harnessLabel: selectedHarness?.label ?? null,
    selectionCatalogConfirmed,
  };
  // Preserve the previous `selection` reference when nothing changed so slice
  // subscribers (picker, send gate) don't wake on every catalog push.
  if (
    previous !== null &&
    previous.selection.harnessId === derived.selection.harnessId &&
    previous.selection.modelSlug === derived.selection.modelSlug
  ) {
    return { ...derived, selection: previous.selection };
  }
  return derived;
}

/**
 * Decide, on a fresh catalog push, whether the resolved settings should EMIT to
 * the surface and whether the RAW sticky slug should be HEALED to the resolved
 * one. Extracted from `setCatalog` so the two comparisons - which intentionally
 * key off DIFFERENT baselines (the previous derived slug for the emit, the raw
 * sticky slug for the heal) - are named and unit-testable in one place rather
 * than inlined into an already-busy action. `healedValues === state.values`
 * whenever nothing is healed, so the caller spreads it unconditionally.
 */
function decideCatalogTransition(
  state: ComposerToolbarState,
  derived: ComposerToolbarDerived,
): { emit: boolean; healedValues: ComposerToolbarValues } {
  // Reroute guard: never emit while the derived harness is a surface clamp of
  // the user's choice, or the rerouted harness would leak into settings.
  const rerouted =
    derived.selection.harnessId !== state.values.selection.harnessId;
  // A catalog LOAD that resolves a previously-CONCRETE slug to a different
  // concrete slug - the delisted self-heal (a stale remembered slug X resolving
  // to the first model Y) - must propagate an emit so the surface live-settings
  // (and the memory write) pick up Y. Compared against the previous DERIVED slug
  // (what the surface last saw), and gated on the NEW derived selection being
  // catalog-confirmed: otherwise an UNLOAD (the query detaches,
  // `modelsLoaded:false`, derive falls back to holding the raw still-stale slug)
  // would look like a Y->X change and re-emit the dead slug. The empty ->
  // first-model INITIAL resolution stays silent (prev slug was ""), matching the
  // seed-doesn't-emit behavior.
  const resolvedSlugSelfHealed =
    derived.selectionCatalogConfirmed &&
    state.selection.modelSlug.length > 0 &&
    derived.selection.modelSlug !== state.selection.modelSlug;
  const emit =
    !rerouted &&
    derived.selection.modelSlug.length > 0 &&
    (state.pendingSettingsEmit || resolvedSlugSelfHealed);
  if (!emit) return { emit: false, healedValues: state.values };
  // Heal the RAW sticky slug to the confirmed resolved one on a delisting
  // (loaded catalog, raw slug concretely absent, not rerouted), so later
  // load/unload cycles don't keep re-deriving the X->Y transition or re-emitting
  // Y. Compared against the RAW sticky slug - the distinct baseline from the
  // emit decision above. Only `modelSlug` is healed (never `harnessId`, so the
  // reroute write-guard is untouched), and only for a confirmed delisting.
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
    a.harnesses === b.harnesses &&
    a.modelsHarnessId === b.modelsHarnessId &&
    a.models === b.models &&
    // Must compare the load status: a pure loading -> loaded transition (e.g. a
    // catalog that loads empty, where `models` stays the same `[]`) would
    // otherwise be skipped here, stranding a deferred emit that never flushes.
    a.modelsLoaded === b.modelsLoaded &&
    a.tuiOnly === b.tuiOnly
  );
}

function modelExists(
  models: ReadonlyArray<ModelOption>,
  harnessId: ProviderId,
  modelSlug: string,
): boolean {
  return models.some(
    (candidate) =>
      candidate.harnessId === harnessId && candidate.slug === modelSlug,
  );
}

// Resolve the concrete model slug the selection presents from a remembered /
// seeded slug that is NOT guaranteed to exist in the loaded catalog:
// - present in the loaded catalog -> keep it (valid);
// - still loading -> hold the slug verbatim ("" stays "", a non-empty remembered
//   slug stays for display), so a valid selection is never reset mid-load;
// - loaded but empty / absent -> first model (an empty slug resolves to the
//   preferred model; a non-empty-but-absent slug was DELISTED).
function resolveModelSlug(
  harnessId: ProviderId,
  modelSlug: string,
  models: ReadonlyArray<ModelOption>,
  catalogLoadedForHarness: boolean,
): string {
  if (modelSlug.length > 0 && modelExists(models, harnessId, modelSlug)) {
    return modelSlug;
  }
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
    // A harness whose availability probe is still in flight is NOT yet known to
    // be unavailable. Keep the user's selection on it rather than rerouting to
    // whichever provider settled first - otherwise a cold boot flickers the
    // composer and, mid-probe, a Send would dispatch the turn on the wrong
    // harness. Capability (`modes`) is static and known even while pending, so
    // the terminal-surface reroute still applies. The send gate blocks on the
    // unresolved (empty) model slug until the probe settles, so a pending
    // selection can't actually launch.
    if (
      harness.id === selection.harnessId &&
      harness.availabilityPending &&
      (!tuiOnly || harness.modes.includes("tui"))
    ) {
      return selection;
    }
    if (!harness.available) continue;
    // On the terminal surface only TUI-capable harnesses are eligible, so a
    // GUI-only selection carried over from chat is rerouted off it - mirroring
    // the availability reroute. Capability is the runtime `modes` advertised by
    // `listGuiHarnesses` (the same signal the terminal picker filters its rail
    // by), NOT the schema id, so a schema-TUI harness whose adapter currently
    // exposes only `gui` (cursor) is rerouted too.
    if (tuiOnly && !harness.modes.includes("tui")) continue;
    firstEligible ??= harness;
    if (harness.id === selection.harnessId) return selection;
  }
  if (firstEligible === null) return selection;
  return { harnessId: firstEligible.id, modelSlug: "" };
}
