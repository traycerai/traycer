/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import {
  useCallback,
  useEffect,
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
import type { JudgeTileRow } from "@/components/settings/panels/permissions/judge-tile-state";

const EMPTY_JUDGE_MODELS: ReadonlyArray<ModelOption> = [];

/**
 * Where a provider switch the store is holding stands: its models are still
 * on their way, they answered with none, or the read failed.
 */
export type JudgePendingModels = "loading" | "empty" | "failed";

/** A provider switch that is waiting for its models, and has not saved. */
export interface JudgePendingSwitch {
  readonly harnessId: ProviderId;
  readonly models: JudgePendingModels;
}

export interface JudgeToolbarStore {
  readonly store: ComposerToolbarStore;
  /** The switch the store is holding, or `null` when nothing is pending. */
  readonly pendingSwitch: JudgePendingSwitch | null;
  /**
   * What closing the picker does to the store. A switch still waiting for its
   * models survives, and saves the moment they land. A switch whose models
   * came back empty or failed is dropped by re-seeding from what is saved, and
   * so is anything else in the store that differs from the seed, so the next
   * open starts from the machine's judge.
   */
  readonly settleOnClose: () => void;
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
 * The seed key is `[row, seed, nonce]`. The row is part of it so the store
 * re-seeds when the card changes rows over the same selection; the nonce is
 * how a close throws away an abandoned switch, since re-applying an unchanged
 * key is a no-op by design.
 */
export function useJudgeToolbarStore(input: {
  readonly seedRow: JudgeTileRow;
  readonly seed: HarnessModelSelection;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly onPick: (selection: AutoJudgeSelection) => void;
}): JudgeToolbarStore {
  const { seedRow, harnesses, onPick } = input;
  const seed = useStableSeed(input.seed);
  const [nonce, setNonce] = useState(0);
  const seedKey = JSON.stringify([seedRow, seed, nonce]);
  const [store] = useState(() =>
    createComposerToolbarStore({
      purpose: "setting",
      seedKey,
      values: judgeToolbarValues(seed),
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    }),
  );

  // The writer is installed through the store's setter, not baked in at
  // creation, so it never writes through a stale closure. The store never
  // emits an unresolved model; the guard makes "no write carries `model: \"\"`"
  // a property of this file too.
  const writeJudge = useCallback(
    (settings: ChatRunSettings) => {
      if (settings.model.length === 0) return;
      onPick({
        harnessId: settings.harnessId,
        model: settings.model,
        profileId: settings.profileId,
      });
    },
    [onPick],
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(writeJudge);
  }, [store, writeJudge]);

  // Before paint, so the face never shows a frame of the old seed. A provider
  // switch that is waiting for its models is a pick made on this card that
  // has not settled, and it wins over a re-derived seed - a harness list or a
  // verdict settling on a cold host must not throw it away. It ends by
  // emitting (a new pick, so a new key) or by a close bumping the nonce.
  const appliedNonce = useRef(nonce);
  useLayoutEffect(() => {
    const state = store.getState();
    if (state.pendingSettingsEmit && appliedNonce.current === nonce) return;
    appliedNonce.current = nonce;
    state.applySeed(seedKey, judgeToolbarValues(seed));
  }, [store, seedKey, seed, nonce]);

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

  const pending = useStore(store, (state) => state.pendingSettingsEmit);
  const pendingModels = pendingModelsState(available, modelsQuery);
  const pendingSwitch =
    pending && pendingModels !== null
      ? { harnessId, models: pendingModels }
      : null;

  const settleOnClose = (): void => {
    const state = store.getState();
    if (state.pendingSettingsEmit) {
      if (pendingModels === "loading") return;
      setNonce((current) => current + 1);
      return;
    }
    if (!sameSelection(state.values.selection, seed)) {
      setNonce((current) => current + 1);
    }
  };

  return { store, pendingSwitch, settleOnClose };
}

/**
 * The values the store is seeded with. `permission`, `reasoning` and
 * `serviceTier` are inert: a judge record is `(harness, model, profile)`, and
 * the picker hides both footers.
 */
function judgeToolbarValues(
  selection: HarnessModelSelection,
): ComposerToolbarValues {
  return {
    permission: DEFAULT_PERMISSION,
    selection,
    reasoning: "",
    serviceTier: "",
  };
}

/**
 * Where the store harness's models stand for a pending switch. `null` when
 * none of the three applies: the catalog listed models (the switch has
 * already saved), or the provider is not available, so no read is coming.
 */
function pendingModelsState(
  available: boolean,
  query: UseQueryResult<ListGuiAgentModelsResponse, HostRpcError>,
): JudgePendingModels | null {
  const models = query.data?.models;
  if (models !== undefined) return models.length === 0 ? "empty" : null;
  if (!available) return null;
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
