import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  AutoJudgeBlocked,
  AutoJudgeEffective,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import { resolveModelBySlug } from "@traycer/protocol/host/agent/gui/model-slug-resolution";
import { Button } from "@/components/ui/button";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  autoJudgeSeed,
  autoJudgeSelectionFrom,
  type AutoJudgeSeed,
} from "@/components/settings/panels/auto-judge-selection";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import {
  useGuiHarnessModelsQueryForClient,
  useGuiHarnessesQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  autoJudgeBillingFor,
  autoJudgeSelfBillingWarning,
} from "@/lib/auto-mode/auto-judge-billing";

const EMPTY_JUDGE_MODELS: ReadonlyArray<ModelOption> = [];

/**
 * A toolbar store wired for the Settings judge row.
 *
 * Deliberately NOT `useComposerToolbarStore`: that hook installs a wrapper that
 * records every commit into `composer-harness-memory-store`, which is the
 * memory a COMPOSER reads to seed "the model I last used on this provider".
 * Pinning a cheap judge model would then quietly become the model the next chat
 * on that provider offers. This wiring keeps everything else - the same store,
 * the same catalog queries, the same commit funnel through the picker - and
 * writes only where the judge is stored.
 *
 * One memory write survives, from inside the picker's own `commitSelection`:
 * the last profile browsed for a provider. That one is a fact about which
 * credential the user pointed at, and the picker owns it; it is not the model
 * memory a composer seeds from.
 */
function useAutoJudgeToolbarStore(input: {
  readonly hostId: string | null;
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly onCommit: (selection: AutoJudgeSelection) => void;
}): { readonly store: ComposerToolbarStore; readonly seed: AutoJudgeSeed } {
  const { hostId, selection, effective, onCommit } = input;
  const hostClient = useHostClientForHostId(hostId);
  const harnessesQuery = useGuiHarnessesQueryForClient(hostClient, {
    enabled: true,
    subscribed: true,
  });
  const harnesses = harnessesQuery.data?.harnesses;
  // Memoized so the seed effect below fires on a real change of the stored
  // selection or the catalog, not on every render. `applySeed` no-ops on a
  // matching key anyway; this keeps the dependency honest rather than relying
  // on that.
  const seed = useMemo(
    () => autoJudgeSeed(selection, harnesses, effective),
    [selection, harnesses, effective],
  );
  const [store] = useState(() =>
    createComposerToolbarStore({
      seedKey: seed.seedKey,
      values: seed.values,
      onSettingsChange: null,
      tuiOnly: false,
      hostId,
    }),
  );
  // The writer is installed through the store's setter, not baked in at
  // creation, so a re-render with a fresh `onCommit` identity cannot leave the
  // store writing through a stale closure. Memoized on `onCommit` so the
  // setter's own identity guard can hold - a fresh arrow every render would
  // `set()` the store, and wake its subscribers, on every render.
  const writeJudge = useCallback(
    (settings: ChatRunSettings) => onCommit(autoJudgeSelectionFrom(settings)),
    [onCommit],
  );
  useEffect(() => {
    store.getState().setOnSettingsChange(writeJudge);
  }, [store, writeJudge]);
  // Layout effect, matching `useComposerToolbarStore`: a seed that arrives
  // (the stored selection landing, the catalog resolving its harness) must be
  // in the store before paint, so the trigger never shows one frame of the
  // default under a host that has a selection.
  useLayoutEffect(() => {
    store.getState().applySeed(seed.seedKey, seed.values);
  }, [store, seed.seedKey, seed.values]);

  const harnessId = useStore(store, (s) => s.selection.harnessId);
  const modelsQuery = useGuiHarnessModelsQueryForClient(
    hostClient,
    harnessId,
    null,
    { enabled: true, subscribed: true },
  );
  const models = modelsQuery.data?.models;
  const modelsLoaded = modelsQuery.data !== undefined;
  useEffect(() => {
    store.getState().setCatalog({
      hostId,
      harnesses,
      modelsHarnessId: harnessId,
      models: models ?? EMPTY_JUDGE_MODELS,
      modelsLoaded,
      tuiOnly: false,
    });
  }, [store, hostId, harnesses, harnessId, models, modelsLoaded]);

  return { store, seed };
}

/**
 * The judge's harness + model, chosen with the same picker a composer uses.
 *
 * The picker is the whole point of reusing it: the judge runs on a real
 * provider, with a real profile, and the rail already knows which of them are
 * installed, signed in and degraded on this host. Both footers are off - a
 * judge has no thinking-effort or fast-mode axis to set.
 */
export function AutoJudgePicker(props: {
  readonly hostId: string | null;
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly blocked: AutoJudgeBlocked | null | undefined;
  readonly disabled: boolean;
  readonly onCommit: (selection: AutoJudgeSelection) => void;
}) {
  const { store, seed } = useAutoJudgeToolbarStore({
    hostId: props.hostId,
    selection: props.selection,
    effective: props.effective,
    onCommit: props.onCommit,
  });
  const blocked = props.blocked ?? null;
  // The toolbar store PRESENTS the first eligible harness when the selected one
  // is unavailable, and never emits that clamp (it is a display fallback, not a
  // choice). Right for a composer, where the reroute is what the next turn will
  // actually run on - and a lie here, because the HOST still tries the stored
  // harness, finds it unavailable, and escalates every call to the human
  // instead. So the row says so. Settled facts only: the reroute passes a
  // selection through untouched while the catalog is loading and while the
  // harness's own availability probe is in flight.
  const presentedHarnessId = useStore(store, (s) => s.selection.harnessId);
  const storedHarnessId = seed.values.selection.harnessId;
  const storedHarnessUnavailable =
    props.selection !== null &&
    seed.unrecognizedHarnessId === null &&
    presentedHarnessId !== storedHarnessId;
  // Read off the STORED record, not the presented harness, for two reasons:
  // the host bills whatever it has stored (the presented id can be a display
  // reroute off an unavailable harness, which the line above already names),
  // and the composer's own meta line reads the same record - so the two
  // surfaces cannot disagree about which pocket is being spent.
  const selfBilling = autoJudgeSelfBillingWarning(
    autoJudgeBillingFor(props.selection?.harnessId ?? null),
  );
  return (
    <div
      className="flex min-w-0 flex-col items-end gap-1"
      data-testid="auto-judge-picker"
    >
      <HarnessModelPicker
        store={store}
        withServiceTier={false}
        withReasoning={false}
        tuiOnly={false}
        lockedHarnessId={null}
        disabled={props.disabled}
        // Not the composer's toggle target: the `composer.model-picker.toggle`
        // shortcut and the palette's "Change model…" belong to whatever chat
        // is open behind Settings, and must not land here.
        registerActivation={false}
        createProfileHostId={props.hostId}
        runTargetHostId={props.hostId}
        // No terminal to open a provider's setup session into from Settings;
        // the panel shows the steps without the button.
        terminalLoginSurface={null}
        labelDisplay="responsive"
        profileAdmission={null}
      />
      <AutoJudgeStatus
        store={store}
        selection={props.selection}
        effective={props.effective}
        blocked={blocked}
      />
      {selfBilling !== null ? (
        <span
          data-testid="auto-judge-self-billing"
          className="max-w-full text-pretty text-right text-ui-xs text-amber-700 dark:text-amber-300"
        >
          {selfBilling}
        </span>
      ) : null}
      {blocked === null && seed.unrecognizedHarnessId !== null ? (
        <span
          data-testid="auto-judge-unrecognized"
          className="max-w-full text-pretty text-right text-ui-xs text-amber-700 dark:text-amber-300"
        >
          This host runs the judge on {seed.unrecognizedHarnessId}, which this
          version of the app doesn&apos;t know. Pick one to replace it.
        </span>
      ) : null}
      {blocked === null && storedHarnessUnavailable ? (
        <span
          data-testid="auto-judge-unavailable"
          className="max-w-full text-pretty text-right text-ui-xs text-amber-700 dark:text-amber-300"
        >
          The judge is set to {seed.storedHarnessLabel ?? storedHarnessId},
          which isn&apos;t available on this machine - Auto mode will ask you
          instead of judging. Pick a provider this machine can run.
        </span>
      ) : null}
    </div>
  );
}

function AutoJudgeStatus(props: {
  readonly store: ComposerToolbarStore;
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly blocked: AutoJudgeBlocked | null;
}) {
  const catalog = useStore(props.store, (s) => s.catalog);
  const { effective, blocked, selection } = props;
  if (blocked !== null) {
    return (
      <AutoJudgeBlockedStatus
        blocked={blocked}
        harnessId={effective?.harnessId ?? selection?.harnessId ?? "traycer"}
      />
    );
  }
  if (effective === undefined) {
    if (selection !== null) return null;
    return (
      <span className="text-ui-xs text-muted-foreground">
        Using Traycer&apos;s default judge
      </span>
    );
  }
  if (effective === null) return null;
  const modelMatch =
    catalog.modelsHarnessId === effective.harnessId
      ? resolveModelBySlug(catalog.models, effective.model)
      : null;
  const modelLabel =
    modelMatch !== null && modelMatch.kind !== "none"
      ? modelMatch.model.label
      : effective.model;
  return (
    <span
      className="text-ui-xs text-muted-foreground"
      data-testid="auto-judge-effective"
    >
      {effective.source === "default"
        ? "Using Traycer's default judge"
        : "Using selected judge"}{" "}
      · {modelLabel}
    </span>
  );
}

function AutoJudgeBlockedStatus(props: {
  readonly blocked: AutoJudgeBlocked;
  readonly harnessId: string;
}) {
  const { openSettings } = useSystemTabModalActions();
  const billing = autoJudgeBillingFor(props.harnessId);
  const providerLabel =
    billing.kind === "traycer" ? "Traycer inference" : billing.harnessLabel;
  let message: ReactNode;
  switch (props.blocked.reason) {
    case "provider-disabled":
      message = (
        <>
          {providerLabel} is disabled on this machine, so no judge will run.
          Enable it under{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-inherit text-ui-xs underline"
            onClick={() =>
              openSettings({ section: "providers", resetToGeneral: false })
            }
          >
            Providers
          </Button>
          , or pick another judge.
        </>
      );
      break;
    case "no-default":
      message =
        "This machine has no default judge model, so no judge will run. Pick a judge above.";
      break;
    case "unsupported-harness":
      message = `This machine does not support the ${providerLabel} judge. Pick another judge above.`;
      break;
  }
  return (
    <span
      data-testid="auto-judge-blocked"
      className="max-w-full text-pretty text-right text-ui-xs text-amber-700 dark:text-amber-300"
    >
      {message}
    </span>
  );
}
