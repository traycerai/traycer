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
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  autoJudgeRecordHealth,
  autoJudgeSeed,
  autoJudgeSeedKeyForAttempt,
  autoJudgeSelectionFrom,
  offeredJudgeProfileIds,
  type AutoJudgeRecordHealth,
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
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
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
  readonly resetNonce: number;
  readonly onCommit: (selection: AutoJudgeSelection) => void;
}): { readonly store: ComposerToolbarStore; readonly seed: AutoJudgeSeed } {
  const { hostId, selection, effective, resetNonce, onCommit } = input;
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
      chatLineCarriesAutoMode: null,
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
  //
  // The key carries `resetNonce`, which is what makes a ROLLBACK possible at
  // all. After a refused write the store holds the user's pick and the cache
  // still holds the record the host actually has - so the seed derived from
  // that record is unchanged, and re-applying it would hit `applySeed`'s
  // matching-key early return and do nothing. Bumping the nonce makes it a
  // different seed, and the same values then land. `applySeed` never emits, so
  // the rollback cannot re-enter `onCommit` and start a write loop.
  const appliedSeedKey = autoJudgeSeedKeyForAttempt(seed.seedKey, resetNonce);
  useLayoutEffect(() => {
    store.getState().applySeed(appliedSeedKey, seed.values);
  }, [store, appliedSeedKey, seed.values]);

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
      chatLineCarriesAutoMode: null,
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
/**
 * Which profile commit ids the stored judge harness still offers.
 *
 * Its own hook, and both halves of that are deliberate. The PROFILE is the one
 * member of the record the toolbar store cannot report on: it carries
 * `profileId` through untouched, and the display fallback to the provider's
 * first profile happens inside `HarnessModelPicker`
 * (`resolveActiveProfileForHarness`), where nothing above it can see the
 * substitution. So this asks the underlying fact - does that provider still
 * have the profile - instead of comparing a presented value with a stored one.
 *
 * Extracted rather than inlined because the query and its projection pushed
 * `AutoJudgePicker` past the complexity ceiling gui-app lints at, which is the
 * same signal that moved `autoJudgeRecordHealth` out of it. The projection
 * itself lives in `auto-judge-selection.ts` with the module's other pure
 * halves; what is left here is the read.
 *
 * Resolved through the same client the store's own catalog reads use, so it
 * shares their `providers.list` cache slot rather than issuing a request of its
 * own on a surface that already holds one.
 */
function useOfferedJudgeProfileIds(
  hostId: string | null,
  storedHarnessId: string,
): ReadonlyArray<string | null> | undefined {
  const providersQuery = useProvidersListForClient(
    useHostClientForHostId(hostId),
    { enabled: true, subscribed: true },
  );
  const providers = providersQuery.data?.providers;
  return useMemo(
    () => offeredJudgeProfileIds(providers, storedHarnessId),
    [providers, storedHarnessId],
  );
}

export function AutoJudgePicker(props: {
  readonly hostId: string | null;
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly blocked: AutoJudgeBlocked | null | undefined;
  readonly disabled: boolean;
  /** A write is in flight: draws the inline spinner beside the trigger. */
  readonly saving: boolean;
  /**
   * Whether `autoJudge.get` has actually ANSWERED for this host.
   *
   * Distinct from `selection`/`effective` being null or undefined, which is the
   * conflation it exists to end: `effective === undefined` is the shape a LEGACY
   * host produces (it predates the widened field), and it is also the shape a
   * read that has not landed - or has failed - produces. The status line reads
   * the second as the first and announces "Using Traycer's default judge" about
   * a record it has never seen.
   */
  readonly recordLoaded: boolean;
  /**
   * Bumped by the row on every REFUSED write, to roll the picker back onto the
   * record the host actually holds. See `autoJudgeSeedKeyForAttempt`.
   */
  readonly resetNonce: number;
  /**
   * `null` is the CLEAR, not an absence of intent: `autoJudgeSetRequestSchema`
   * reserves it for "drop the override and follow the catalog default again",
   * and the picker below is the only thing that can send it.
   */
  readonly onCommit: (selection: AutoJudgeSelection | null) => void;
}) {
  const { store, seed } = useAutoJudgeToolbarStore({
    hostId: props.hostId,
    selection: props.selection,
    effective: props.effective,
    resetNonce: props.resetNonce,
    onCommit: props.onCommit,
  });
  const blocked = props.blocked ?? null;
  // The toolbar store PRESENTS a substitute whenever the stored harness or model
  // is not on offer, and never emits that clamp (a display fallback, not a
  // choice). Right for a composer, where the reroute is what the next turn will
  // actually run on - and a lie here, because the HOST still tries the stored
  // record, fails, and escalates every call to the human instead. So the row
  // says so. The decision is pure and lives in `autoJudgeRecordHealth`; what is
  // left here is reading the presented values off the store.
  const presentedHarnessId = useStore(store, (s) => s.selection.harnessId);
  const presentedModelSlug = useStore(store, (s) => s.selection.modelSlug);
  const modelsLoaded = useStore(store, (s) => s.catalog.modelsLoaded);
  const storedHarnessId = seed.values.selection.harnessId;
  const storedModelSlug = seed.values.selection.modelSlug;
  const storedProfileId = seed.values.selection.profileId;
  const offeredProfileIds = useOfferedJudgeProfileIds(
    props.hostId,
    storedHarnessId,
  );
  const health = autoJudgeRecordHealth({
    hasStoredSelection: props.selection !== null,
    unrecognizedHarnessId: seed.unrecognizedHarnessId,
    isBlocked: blocked !== null,
    saving: props.saving,
    storedHarnessId,
    presentedHarnessId,
    storedModelSlug,
    presentedModelSlug,
    modelsLoaded,
    storedProfileId,
    offeredProfileIds,
  });
  // Read off the STORED record, not the presented harness, for two reasons:
  // the host bills whatever it has stored (the presented id can be a display
  // reroute off an unavailable harness, which the line above already names),
  // and the composer's own meta line reads the same record - so the two
  // surfaces cannot disagree about which pocket is being spent.
  //
  // Suppressed entirely when nothing will call a judge. The composer's
  // disclosure already folds `blocked` in (`autoJudgeBillingForRun`); this is
  // the Settings half of the same rule.
  const selfBilling = health.noJudgeWillRun
    ? null
    : autoJudgeSelfBillingWarning(
        autoJudgeBillingFor(props.selection?.harnessId ?? null),
      );
  return (
    <div
      className="flex min-w-0 flex-col items-end gap-1"
      data-testid="auto-judge-picker"
    >
      {/* The trigger and its pending spinner share a row, which is the repo's
          pending-mutation shape: `disabled` while in flight, the label
          untouched, an inline spinner beside it. The row owns `disabled`
          because it owns the mutation; this component only draws it. */}
      <div className="flex min-w-0 items-center gap-2">
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
        {props.saving ? <MutedAgentSpinner /> : null}
      </div>
      <AutoJudgeStatus
        recordLoaded={props.recordLoaded}
        store={store}
        selection={props.selection}
        effective={props.effective}
        blocked={blocked}
      />
      {/* The only route back to the catalog default. Every other control here
          commits a CONCRETE harness+model, so before this existed the first
          pick was permanent in one direction: the record could be moved but
          never cleared, and a user who had chosen once stopped receiving
          Traycer's future default-model changes with no way back short of
          editing host state by hand. `selection: null` is the contract's own
          spelling for that (`autoJudgeSetRequestSchema`), so this sends it
          rather than guessing today's default and pinning THAT - which would
          be the same trap wearing a different value.

          Rendered only when there is an override to clear: on a host that has
          none, the row already reads "Using Traycer's default judge" and a
          button that would send the state it is already in is noise. */}
      {props.selection !== null ? (
        <Button
          type="button"
          variant="muted"
          size="xs"
          data-testid="auto-judge-use-default"
          disabled={props.disabled}
          onClick={() => props.onCommit(null)}
        >
          Use Traycer&apos;s default
        </Button>
      ) : null}
      {selfBilling !== null ? (
        <span
          data-testid="auto-judge-self-billing"
          className="max-w-full text-pretty text-right text-ui-xs text-warning-foreground"
        >
          {selfBilling}
        </span>
      ) : null}
      <AutoJudgeRecordWarnings
        health={health}
        blocked={blocked}
        unrecognizedHarnessId={seed.unrecognizedHarnessId}
        storedHarnessLabel={seed.storedHarnessLabel ?? storedHarnessId}
        storedModelSlug={storedModelSlug}
      />
    </div>
  );
}

const RECORD_WARNING_CLASSNAME =
  "max-w-full text-pretty text-right text-ui-xs text-warning-foreground";

/**
 * What is wrong with the stored judge record, as the user reads it.
 *
 * Its own component for the reason `autoJudgeRecordHealth` is its own function:
 * four near-identical amber lines in the picker's body is one decision wearing
 * a disguise, and inline they put `AutoJudgePicker` over the complexity ceiling
 * gui-app lints at. The DECISIONS all live in `health`; this only chooses a
 * sentence.
 *
 * A live `blocked` silences every line: the host has already said it cannot run
 * the judge, and its own status already says so - a second amber line naming a
 * particular field would read as a second, separate problem.
 *
 * The profile line is additionally suppressed under an unavailable HARNESS,
 * because a harness that is gone took its accounts with it and the harness line
 * is the finding; `autoJudgeRecordHealth` already gates the flag the same way,
 * and this restates the pairing only in what it renders.
 */
function AutoJudgeRecordWarnings(props: {
  readonly health: AutoJudgeRecordHealth;
  readonly blocked: AutoJudgeBlocked | null;
  readonly unrecognizedHarnessId: string | null;
  readonly storedHarnessLabel: string;
  readonly storedModelSlug: string;
}) {
  if (props.blocked !== null) return null;
  if (props.unrecognizedHarnessId !== null) {
    return (
      <span
        data-testid="auto-judge-unrecognized"
        className={RECORD_WARNING_CLASSNAME}
      >
        This host runs the judge on {props.unrecognizedHarnessId}, which this
        version of the app doesn&apos;t know. Pick one to replace it.
      </span>
    );
  }
  return (
    <>
      {props.health.storedModelUnavailable ? (
        <span
          data-testid="auto-judge-model-unavailable"
          className={RECORD_WARNING_CLASSNAME}
        >
          The judge is set to {props.storedModelSlug}, which this machine no
          longer offers - Auto mode will ask you instead of judging. Pick a
          model to replace it.
        </span>
      ) : null}
      {props.health.storedProfileUnavailable ? (
        <span
          data-testid="auto-judge-profile-unavailable"
          className={RECORD_WARNING_CLASSNAME}
        >
          The judge is set to an account that has been removed from{" "}
          {props.storedHarnessLabel} - Auto mode will ask you instead of
          judging. Pick an account to replace it.
        </span>
      ) : null}
      {props.health.storedHarnessUnavailable ? (
        <span
          data-testid="auto-judge-unavailable"
          className={RECORD_WARNING_CLASSNAME}
        >
          The judge is set to {props.storedHarnessLabel}, which isn&apos;t
          available on this machine - Auto mode will ask you instead of judging.
          Pick a provider this machine can run.
        </span>
      ) : null}
    </>
  );
}

function AutoJudgeStatus(props: {
  readonly store: ComposerToolbarStore;
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly blocked: AutoJudgeBlocked | null;
  readonly recordLoaded: boolean;
}) {
  const catalog = useStore(props.store, (s) => s.catalog);
  const { effective, blocked, selection } = props;
  // SILENCE until the record has answered. Every branch below makes a claim
  // about what this host has STORED, and before a successful read there is
  // nothing to claim - the `undefined` the legacy-host branch reads as "this
  // host cannot report an effective judge" is the same `undefined` a pending or
  // failed read produces. Saying nothing is the same fail-toward-silence the
  // section takes for an unresolved handshake, and the row already renders its
  // own error hint when the read failed.
  if (!props.recordLoaded) return null;
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
            size="inline-xs"
            className="text-current underline"
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
      className="max-w-full text-pretty text-right text-ui-xs text-warning-foreground"
    >
      {message}
    </span>
  );
}
