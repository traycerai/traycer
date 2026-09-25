/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  GuiHarnessOption,
  ListGuiAgentModelsResponse,
} from "@traycer/protocol/host/index";
import type { AutoJudgeSelection } from "@traycer/protocol/host/auto-mode/contracts";
import { effectiveJudgeReasoningEffort } from "@traycer/protocol/host/agent/gui/reasoning-effort-order";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  DEFAULT_PERMISSION,
  type HarnessModelSelection,
  type ModelOption,
  type ProviderId,
} from "@/components/home/data/landing-options";
import { useGuiHarnessModelsQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
  type ComposerToolbarValues,
} from "@/stores/composer/composer-toolbar-store";
import { judgeSwitchModel } from "@/components/settings/panels/auto-judge-selection";
import type { JudgeTileRow } from "@/components/settings/panels/permissions/judge-tile-state";

const EMPTY_JUDGE_MODELS: ReadonlyArray<ModelOption> = [];

/**
 * Where a provider switch the store is holding stands: its models are still
 * on their way, they answered with none, or the read failed.
 */
export type JudgePendingModels = "loading" | "empty" | "failed";

/**
 * What the store harness's models read says, for a switch it holds: the
 * three the tile reports, a catalog that listed models (the switch saves on
 * the next catalog push), or a provider that is not available (no read is
 * coming).
 */
type JudgePendingModelsRead = JudgePendingModels | "listed" | "unavailable";

/** A provider switch that is waiting for its models, and has not saved. */
export interface JudgePendingSwitch {
  readonly harnessId: ProviderId;
  readonly models: JudgePendingModels;
}

/**
 * A provider switch that was dropped because its models came back empty or
 * failed, kept only so the second tile can still say why nothing was saved.
 * Display state: the store is no longer pending.
 */
export interface JudgeDroppedSwitch {
  readonly harnessId: ProviderId;
  readonly models: "empty" | "failed";
}

export interface JudgeToolbarStore {
  readonly store: ComposerToolbarStore;
  /** The switch the store is holding, or `null` when nothing is pending. */
  readonly pendingSwitch: JudgePendingSwitch | null;
  /**
   * The last switch dropped for having no models or failing to load them,
   * until the picker next opens or a tile is chosen; `null` otherwise.
   */
  readonly droppedSwitch: JudgeDroppedSwitch | null;
  /**
   * What closing the picker does to the store. A switch still waiting for its
   * models survives, and saves the moment they land; one that can no longer
   * save is settled whenever the picker is closed (below). Anything else in
   * the store that differs from the seed is dropped by re-seeding from what
   * is saved, so the next open starts from the machine's judge.
   */
  readonly settleOnClose: () => void;
  /**
   * Ends a pending provider switch by re-seeding from what is saved. Every
   * choice made on the card itself calls it first: the latest click wins, so
   * a switch still waiting for its models must not land after it. It is a
   * tile choice, so it clears `droppedSwitch` too.
   */
  readonly dropPending: () => void;
  /** Clears `droppedSwitch`: a tile was chosen. */
  readonly clearDroppedSwitch: () => void;
  /** The embedding's `providerSwitchModel`. */
  readonly providerSwitchModel: (harnessId: ProviderId) => string;
}

/**
 * The toolbar store behind the judge's picker, and its wiring.
 *
 * Built directly with `createComposerToolbarStore`, never through
 * `useComposerToolbarStore`: that hook's recording wrapper writes composer
 * memory, and a judge pick must not become the model the next chat on that
 * provider offers. The catalog's `hostId` is `null` for the same reason:
 * `recordProfileSelection` drops the write, so no composer-memory write lands
 * from here and no host's memory bucket is read. The picker still reads the
 * scoped machine through its own `runTargetHostId`.
 *
 * `purpose: "setting"`: the store shows exactly what is stored, an unavailable
 * provider or a delisted model included (the status line explains it), and a
 * provider switch is not a composer's `HarnessChanged`.
 *
 * `reasoningFallback: "lowest"`: the store's effort is what the host RUNS. The
 * host runs a stored effort the model still advertises, else the lowest the
 * model advertises (`effectiveJudgeReasoningEffort`), so a seed of `""` (no
 * stored effort, or a provider switch) lands the footer on that lowest level
 * and never on the vendor default a composer would restore.
 *
 * The seed key is `[row, seed, seedReasoning]`. The row is part of it so the
 * store re-seeds when the card changes rows over the same selection. A re-seed
 * from what is saved when the seed itself has not changed - dropping a switch,
 * or settling the picker on close - applies a key of its own, since
 * re-applying an unchanged key is a no-op by design.
 */
export function useJudgeToolbarStore(input: {
  readonly seedRow: JudgeTileRow;
  readonly seed: HarnessModelSelection;
  /**
   * The stored pick's effort, `""` when it has none: the seed of the picker's
   * effort footer, which the store clamps to what the host runs.
   */
  readonly seedReasoning: string;
  /**
   * The seed is the pick on show, so a write naming it again would change
   * nothing: the picker's same-provider click and a click on the checked row
   * write nothing, as in the composer.
   */
  readonly seedIsPick: boolean;
  /**
   * Whether the host's negotiated `autoJudge.set` stores an effort
   * (`autoJudgeSetStoresReasoningEffort`). Below that line the footer is
   * hidden and every write carries `reasoningEffort: null`; the store's own
   * effort then never reaches the wire and never makes a write out of a click
   * that changed nothing else.
   */
  readonly storesEffort: boolean;
  readonly pickerOpen: boolean;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly onPick: (selection: AutoJudgeSelection) => void;
}): JudgeToolbarStore {
  const {
    seedRow,
    seedReasoning,
    seedIsPick,
    storesEffort,
    pickerOpen,
    harnesses,
    onPick,
  } = input;
  const seed = useStableSeed(input.seed);
  const seedKey = JSON.stringify([seedRow, seed, seedReasoning]);
  const [store] = useState(() =>
    createComposerToolbarStore({
      purpose: "setting",
      reasoningFallback: "lowest",
      seedKey,
      values: judgeToolbarValues(seed, seedReasoning),
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    }),
  );

  // Before paint, so the face never shows a frame of the old seed. A provider
  // switch that is waiting for its models is a pick made on this card that
  // has not settled, and it wins over a re-derived seed - a harness list or a
  // verdict settling on a cold host must not throw it away. It ends by
  // emitting (a new pick, so a new seed) or by `reseed`.
  useLayoutEffect(() => {
    const state = store.getState();
    if (state.pendingSettingsEmit) return;
    state.applySeed(seedKey, judgeToolbarValues(seed, seedReasoning));
  }, [store, seedKey, seed, seedReasoning]);

  const reseedCount = useRef(0);
  const reseed = (): void => {
    reseedCount.current += 1;
    store
      .getState()
      .applySeed(
        JSON.stringify([seedRow, seed, seedReasoning, reseedCount.current]),
        judgeToolbarValues(seed, seedReasoning),
      );
  };

  // The models of the STORE's harness, not the saved one's: a provider switch
  // commits `""` for every provider but Claude Code, and only this catalog
  // resolves it. Fetched only while that provider is available - the picker's
  // own gate - so an unavailable provider's slug is held as stored.
  const harnessId = useStore(store, (state) => state.selection.harnessId);
  const available =
    harnesses?.find((row) => row.id === harnessId)?.available === true;
  const modelsQuery = useGuiHarnessModelsQuery(harnessId, null, {
    enabled: available,
    subscribed: true,
  });
  const models = modelsQuery.data?.models;
  const modelsLoaded = models !== undefined;
  useEffect(() => {
    store.getState().setCatalog({
      hostId: null,
      chatLineCarriesAutoMode: null,
      harnesses,
      modelsHarnessId: harnessId,
      models: models ?? EMPTY_JUDGE_MODELS,
      modelsLoaded,
      tuiOnly: false,
    });
  }, [store, harnesses, harnessId, models, modelsLoaded]);

  // The writer is installed through the store's setter, not baked in at
  // creation, so it never writes through a stale closure. The store never
  // emits an unresolved model; the guard makes "no write carries `model: \"\"`"
  // a property of this file too.
  //
  // The effort rides the emit as the store clamped it: the level the footer
  // shows, which is the level the host will run. A write that names the pick
  // on show AND the effort the host already runs for it (the stored effort if
  // the model still offers it, else its lowest - the same rule the seed
  // resolves through) changes nothing and is not sent, so a click on the
  // checked row stays silent whether or not the footer has been touched. It
  // reads the store harness's models below, so it sits after them.
  const writeJudge = useCallback(
    (settings: ChatRunSettings) => {
      if (settings.model.length === 0) return;
      const selection: HarnessModelSelection = {
        harnessId: settings.harnessId,
        modelSlug: settings.model,
        profileId: settings.profileId,
      };
      const effort = storesEffort ? settings.reasoningEffort : null;
      if (
        seedIsPick &&
        sameSelection(selection, seed) &&
        (!storesEffort ||
          effort === seedRunsEffort(models, seed, seedReasoning))
      ) {
        return;
      }
      onPick({
        harnessId: settings.harnessId,
        model: settings.model,
        profileId: settings.profileId,
        reasoningEffort: effort,
      });
    },
    [models, onPick, seed, seedIsPick, seedReasoning, storesEffort],
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(writeJudge);
  }, [store, writeJudge]);

  const pending = useStore(store, (state) => state.pendingSettingsEmit);
  const read = pendingModelsRead(available, modelsQuery);
  const pendingSwitch =
    pending && (read === "loading" || read === "empty" || read === "failed")
      ? { harnessId, models: read }
      : null;

  // A switch that can no longer save - its models answered with none, the
  // read failed, or its provider stopped being available - is settled as soon
  // as the picker is closed, whenever that happens: at the close, or later,
  // when a switch left loading behind a closed picker stops loading. Held, it
  // would keep an amber line under whatever the machine's judge now is, and
  // keep every re-derived seed out. One that had no models, or failed to load
  // them, leaves its sentence behind as display state.
  const abandoned =
    pending &&
    (read === "empty" || read === "failed" || read === "unavailable");
  const [droppedSwitch, clearDroppedSwitch] = useDroppedSwitch({
    pickerOpen,
    abandoned,
    harnessId,
    read,
  });
  const settleAbandoned = useEffectEvent(() => {
    reseed();
  });
  useEffect(() => {
    if (!pickerOpen && abandoned) settleAbandoned();
  }, [pickerOpen, abandoned]);

  const settleOnClose = (): void => {
    const state = store.getState();
    if (state.pendingSettingsEmit) return;
    if (!sameSelection(state.values.selection, seed)) reseed();
  };

  const dropPending = (): void => {
    clearDroppedSwitch();
    if (store.getState().pendingSettingsEmit) reseed();
  };

  // A click on the provider already selected keeps its model, as in the
  // composer, where the same click restores that provider's remembered model.
  // It stops keeping it only once that provider's catalog has loaded without
  // listing it: a model this machine no longer offers is not one to keep, and
  // saving it would save a judge that cannot run (flow 6). While the catalog
  // is still loading nothing yet says the model is gone, so the click keeps
  // it and writes nothing, and the catalog's answer decides from then on.
  // Never an unresolved seed's `""`, which names no model of its own. Then,
  // and for a real switch, the click lands on the provider's recommended
  // judge model, else its first.
  const providerSwitchModel = useCallback(
    (next: ProviderId): string => {
      const state = store.getState();
      const current = state.values.selection;
      const catalogLoaded =
        state.catalog.modelsHarnessId === next && state.catalog.modelsLoaded;
      if (
        current.harnessId === next &&
        current.modelSlug.length > 0 &&
        (!catalogLoaded || state.selectionCatalogConfirmed)
      ) {
        return current.modelSlug;
      }
      return judgeSwitchModel(harnesses, next);
    },
    [store, harnesses],
  );

  return {
    store,
    pendingSwitch,
    droppedSwitch,
    settleOnClose,
    dropPending,
    clearDroppedSwitch,
    providerSwitchModel,
  };
}

/**
 * The line a switch dropped for having no models, or failing to load them,
 * leaves behind: display state, so the tile still says why nothing was saved
 * (spec flow 1), while the switch itself no longer holds the store. It is
 * recorded while the abandoned switch waits for its settle and cleared when
 * the picker next opens - both while rendering, not in an effect - or when a
 * tile is chosen, through the returned clear.
 */
function useDroppedSwitch(input: {
  readonly pickerOpen: boolean;
  readonly abandoned: boolean;
  readonly harnessId: ProviderId;
  readonly read: JudgePendingModelsRead;
}): readonly [JudgeDroppedSwitch | null, () => void] {
  const { pickerOpen, abandoned, harnessId, read } = input;
  const [dropped, setDropped] = useState<JudgeDroppedSwitch | null>(null);
  if (pickerOpen) {
    if (dropped !== null) setDropped(null);
  } else if (abandoned) {
    const next: JudgeDroppedSwitch | null =
      read === "empty" || read === "failed"
        ? { harnessId, models: read }
        : null;
    if (!sameDroppedSwitch(dropped, next)) setDropped(next);
  }
  const clear = useCallback(() => {
    setDropped(null);
  }, []);
  return [dropped, clear];
}

/**
 * The values the store is seeded with. `permission` and `serviceTier` are
 * inert: a judge record carries neither, and the picker hides the Fast footer.
 * `reasoning` is the stored effort, or `""` for none, which the store clamps
 * to the level the host runs (`reasoningFallback: "lowest"`).
 */
function judgeToolbarValues(
  selection: HarnessModelSelection,
  reasoning: string,
): ComposerToolbarValues {
  return {
    permission: DEFAULT_PERMISSION,
    selection,
    reasoning,
    serviceTier: "",
  };
}

/**
 * The effort the host runs the seed at, as the emit would spell it: the
 * stored effort while the model still advertises it, else the model's lowest
 * (`effectiveJudgeReasoningEffort`), and `null` for a model with none or a
 * catalog that has not answered - which is also what the store emits for it.
 */
function seedRunsEffort(
  models: ReadonlyArray<ModelOption> | undefined,
  seed: HarnessModelSelection,
  seedReasoning: string,
): string | null {
  if (models === undefined) return null;
  return (
    effectiveJudgeReasoningEffort(
      models,
      seed.modelSlug,
      seedReasoning.length === 0 ? null : seedReasoning,
    )?.id ?? null
  );
}

/** What the store harness's models read says, for a pending switch. */
function pendingModelsRead(
  available: boolean,
  query: UseQueryResult<ListGuiAgentModelsResponse, HostRpcError>,
): JudgePendingModelsRead {
  const models = query.data?.models;
  if (models !== undefined) return models.length === 0 ? "empty" : "listed";
  if (!available) return "unavailable";
  return query.isError ? "failed" : "loading";
}

/**
 * The seed, kept by identity while its fields are unchanged: the caller derives
 * it afresh each render, and the seed effect should run on a real change.
 */
function useStableSeed(seed: HarnessModelSelection): HarnessModelSelection {
  const [held, setHeld] = useState(seed);
  if (sameSelection(held, seed)) return held;
  setHeld(seed);
  return seed;
}

function sameDroppedSwitch(
  a: JudgeDroppedSwitch | null,
  b: JudgeDroppedSwitch | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.harnessId === b.harnessId && a.models === b.models;
}

function sameSelection(
  a: HarnessModelSelection,
  b: HarnessModelSelection,
): boolean {
  return (
    a.harnessId === b.harnessId &&
    a.modelSlug === b.modelSlug &&
    a.profileId === b.profileId
  );
}
