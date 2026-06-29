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

export interface ComposerToolbarActions {
  readonly setPermission: (next: PermissionMode) => void;
  readonly setSelection: (next: HarnessModelSelection) => void;
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
      // and emit alike.
      setSelection: (next) => {
        const prev = get().values.selection.harnessId;
        if (prev !== next.harnessId) {
          Analytics.getInstance().track(AnalyticsEvent.HarnessChanged, {
            from: prev,
            to: next.harnessId,
          });
        }
        update({ selection: next });
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
        // Same reroute guard as `update`: never flush a deferred edit while the
        // derived harness is a surface clamp of the user's choice, or the
        // rerouted harness would leak into the persisted settings.
        const rerouted =
          derived.selection.harnessId !== state.values.selection.harnessId;
        if (
          !state.pendingSettingsEmit ||
          derived.selection.modelSlug.length === 0 ||
          rerouted
        ) {
          set({ catalog, ...derived });
          return;
        }
        // The deferred edit can finally emit with a concrete model slug.
        set({ catalog, ...derived, pendingSettingsEmit: false });
        state.onSettingsChange?.(settingsFromDerived(derived));
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
  const models =
    catalog.modelsHarnessId === availabilitySelection.harnessId
      ? catalog.models
      : EMPTY_MODELS;
  // An empty `modelSlug` is the transient "unresolved / catalog loading"
  // marker. Resolve it to the preferred (first-listed) model's concrete slug
  // once the harness's catalog loads, so the selection clears the composer
  // send gate (which blocks an empty slug) rather than sticking.
  const resolvedSlug =
    availabilitySelection.modelSlug.length > 0
      ? availabilitySelection.modelSlug
      : (findDefaultModel(models)?.slug ?? "");
  const selection: HarnessModelSelection =
    resolvedSlug === availabilitySelection.modelSlug
      ? availabilitySelection
      : { harnessId: availabilitySelection.harnessId, modelSlug: resolvedSlug };
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

function sameCatalog(
  a: ComposerToolbarCatalog,
  b: ComposerToolbarCatalog,
): boolean {
  return (
    a.harnesses === b.harnesses &&
    a.modelsHarnessId === b.modelsHarnessId &&
    a.models === b.models &&
    a.tuiOnly === b.tuiOnly
  );
}

function effectiveSelectionFromHarnesses(
  selection: HarnessModelSelection,
  harnesses: ReadonlyArray<HarnessOption> | undefined,
  tuiOnly: boolean,
): HarnessModelSelection {
  if (harnesses === undefined) return selection;
  let firstEligible: HarnessOption | null = null;
  for (const harness of sortGuiHarnessesByProviderOrder(harnesses)) {
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
