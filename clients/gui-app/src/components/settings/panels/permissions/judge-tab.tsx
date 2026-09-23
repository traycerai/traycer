/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import { SettingsGroup } from "@/components/settings/settings-group";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAutoJudgeQuery } from "@/hooks/auto-mode/use-auto-judge-query";
import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import { autoJudgeModelLabel } from "@/hooks/auto-mode/use-auto-judge-billing";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  useGuiHarnessModelsQuery,
  useGuiHarnessesQuery,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { PERMISSIONS } from "@/components/settings/panels/permissions-settings.definitions";
import {
  autoJudgeRecordHealth,
  defaultJudgeModelFor,
  firstOfferedJudgeProfileId,
  judgeProviderBlocker,
  judgeSelectionForProvider,
  offeredJudgeProfileIds,
  providerForHarness,
  type JudgeProviderBlocker,
} from "@/components/settings/panels/auto-judge-selection";
import {
  AutoModeHostGate,
  AutoModeUnsupportedLine,
} from "@/components/settings/panels/permissions/auto-mode-host-gate";
import { JudgeModelField } from "@/components/settings/panels/permissions/judge-model-field";
import { ProviderJudgeSwitch } from "@/components/settings/panels/permissions/provider-judge-switch";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const PREDATES_AUTO_MODE =
  "This machine's host predates Auto mode. Update it to choose a judge and write a policy.";

/**
 * The measured range for a metered pocket, restated from the composer's meta
 * line (`auto-judge-billing.ts`), where it is not exported.
 */
const COPILOT_PREMIUM_REQUESTS_PER_HOUR = "60–350";

/** A typed harness id for the models query while no provider is chosen. */
const IDLE_MODELS_HARNESS_ID = providerIdToGuiHarnessId("traycer");

const COPILOT_HARNESS_ID = providerIdToGuiHarnessId("copilot");

/**
 * Settings ▸ Permissions ▸ Judge: which model reviews commands in Auto mode on
 * this machine, and which providers review their own.
 */
export function JudgeTab(): ReactNode {
  return (
    <AutoModeHostGate
      method="autoJudge.get"
      unsupported={
        <AutoModeUnsupportedLine>{PREDATES_AUTO_MODE}</AutoModeUnsupportedLine>
      }
    >
      {(hostId) => (
        <div className="flex flex-col gap-5">
          <SettingsGroup
            group={PERMISSIONS.definitions.autoModeJudge}
            showTitle
            tone="default"
            dataTestId={undefined}
            fill={false}
          >
            <AutoJudgeControls hostId={hostId} />
          </SettingsGroup>
          <BuiltInReviewers />
        </div>
      )}
    </AutoModeHostGate>
  );
}

/**
 * A pick the controls present before the host has stored it. `id` orders
 * picks, so only the LATEST one's settlement clears it - an older write
 * landing must not snap the controls back to a superseded choice.
 */
interface JudgeDraft {
  readonly id: number;
  readonly selection: AutoJudgeSelection | null;
  /**
   * A provider was chosen whose default model is only known from its catalog,
   * which has not answered; the pick commits once it does.
   */
  readonly awaitingModels: boolean;
  /** Ready to be sent; the effect below sends each draft exactly once. */
  readonly dispatch: boolean;
}

/** What the controls present, and the one way to change it. */
interface JudgePick {
  /** The latest pick, until its write settles; `null` shows the record. */
  readonly draft: JudgeDraft | null;
  /** The selection on screen: the latest pick, else the stored record. */
  readonly displayed: AutoJudgeSelection | null;
  readonly displayedRow: GuiHarnessOption | undefined;
  /** The displayed provider's catalog, `undefined` while it has not answered. */
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly request: (
    selection: AutoJudgeSelection | null,
    awaitingModels: boolean,
  ) => void;
}

/**
 * A provider chosen before its catalog answered commits the moment it does.
 * The same draft when nothing changes, so the render-phase adjustment settles.
 */
function resolveAwaitedDraft(input: {
  readonly draft: JudgeDraft | null;
  readonly displayed: AutoJudgeSelection | null;
  readonly row: GuiHarnessOption | undefined;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
}): JudgeDraft | null {
  const { draft, displayed, row, models } = input;
  if (draft === null || !draft.awaitingModels || row === undefined) {
    return draft;
  }
  const model = defaultJudgeModelFor(row, models);
  if (model !== null && displayed !== null) {
    return {
      ...draft,
      selection: { ...displayed, model },
      awaitingModels: false,
      dispatch: true,
    };
  }
  // The catalog answered with nothing to judge on: the pick stays on screen,
  // uncommitted, and the Model field says so.
  if (models !== undefined) return { ...draft, awaitingModels: false };
  return draft;
}

/**
 * The pick a provider choice makes: its default model when one is known now,
 * else the provider alone, waiting for its catalog.
 */
function providerPick(input: {
  readonly row: GuiHarnessOption;
  readonly provider: ProviderCliState | undefined;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
}): {
  readonly selection: AutoJudgeSelection;
  readonly awaitingModels: boolean;
} {
  const selection = judgeSelectionForProvider(input);
  if (selection !== null) return { selection, awaitingModels: false };
  return {
    selection: {
      harnessId: input.row.id,
      model: "",
      profileId: firstOfferedJudgeProfileId(input.provider),
    },
    awaitingModels: true,
  };
}

/**
 * The judge the controls present, and the write behind it.
 *
 * **Nothing is disabled while a write is in flight.** The mutation's
 * host-scoped queue orders two picks; what the old disable was standing in for
 * is that the controls must not RESEED from the record while a write is
 * pending, and they do not - they present the latest pick (`draft`) until its
 * write settles, whatever earlier writes do. A refused write clears the draft,
 * which is the rollback: the controls fall back to the record the host holds.
 */
function useJudgePick(
  stored: AutoJudgeSelection | null,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
): JudgePick {
  const setJudge = useAutoJudgeSetMutation();
  const [draft, setDraft] = useState<JudgeDraft | null>(null);
  const lastDraftId = useRef(0);
  const displayed = draft === null ? stored : draft.selection;
  const displayedRow =
    displayed === null
      ? undefined
      : harnesses?.find((row) => row.id === displayed.harnessId);
  const modelsQuery = useGuiHarnessModelsQuery(
    displayedRow?.id ?? IDLE_MODELS_HARNESS_ID,
    null,
    {
      enabled: displayedRow !== undefined,
      subscribed: displayedRow !== undefined,
    },
  );
  const models =
    displayedRow === undefined ? undefined : modelsQuery.data?.models;

  // Adjusted during render rather than in an effect, so the draft never shows
  // an empty model for a frame after the catalog is known.
  const resolved = resolveAwaitedDraft({
    draft,
    displayed,
    row: displayedRow,
    models,
  });
  if (resolved !== draft) setDraft(resolved);

  const mutateJudge = setJudge.mutate;
  const dispatched = useRef(new Set<number>());
  useEffect(() => {
    if (draft === null || !draft.dispatch) return;
    if (dispatched.current.has(draft.id)) return;
    dispatched.current.add(draft.id);
    const id = draft.id;
    const settle = (): void => {
      setDraft((current) => (current?.id === id ? null : current));
    };
    // Per-call callbacks fire only for the latest `mutate`, which is the only
    // draft whose settlement may clear the controls.
    mutateJudge(
      { selection: draft.selection },
      { onSuccess: settle, onError: settle },
    );
  }, [draft, mutateJudge]);

  const request = (
    selection: AutoJudgeSelection | null,
    awaitingModels: boolean,
  ): void => {
    lastDraftId.current += 1;
    setDraft({
      id: lastDraftId.current,
      selection,
      awaitingModels,
      dispatch: !awaitingModels,
    });
  };
  return { draft, displayed, displayedRow, models, request };
}

/**
 * The Auto mode judge: Automatic, or a specific provider, account and model.
 * Only a record that has not loaded yet (a pick would overwrite a selection
 * this window has not seen) or a host that cannot store one disables it.
 */
function AutoJudgeControls(props: {
  readonly hostId: string | null;
}): ReactNode {
  const query = useAutoJudgeQuery();
  const canWrite = useHostSupportsMethod(props.hostId, "autoJudge.set");
  const harnesses = useGuiHarnessesQuery({ enabled: true, subscribed: true })
    .data?.harnesses;
  const providers = useProvidersList({ enabled: true, subscribed: true }).data
    ?.providers;
  const record = query.data;
  const pick = useJudgePick(record?.selection ?? null, harnesses);
  const [specificChosen, setSpecificChosen] = useState(false);
  const disabled = record === undefined || !canWrite;
  const mode =
    pick.displayed !== null || specificChosen ? "specific" : "automatic";

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="text-ui-sm text-muted-foreground">
        {PERMISSIONS.definitions.autoModeJudge.description}
      </p>
      {query.isError ? (
        <p className="text-ui-sm font-medium text-warning-foreground">
          Couldn&apos;t read this machine&apos;s judge. Reopen Settings to try
          again.
        </p>
      ) : null}
      {canWrite ? null : (
        <p className="text-ui-sm font-medium text-warning-foreground">
          This machine&apos;s host can&apos;t change the judge. Update it to
          pick a different one.
        </p>
      )}
      <RadioGroup
        value={mode}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === "automatic") {
            setSpecificChosen(false);
            if (pick.displayed !== null) pick.request(null, false);
          } else if (next === "specific") {
            setSpecificChosen(true);
          }
        }}
      >
        <AutomaticOption
          record={record}
          pick={pick}
          harnesses={harnesses}
          copilotEnabled={
            providers?.some(
              (provider) =>
                provider.providerId === "copilot" && provider.enabled,
            ) ?? false
          }
        />
        <SpecificOption
          open={mode === "specific"}
          record={record}
          pick={pick}
          harnesses={harnesses}
          providers={providers}
          disabled={disabled}
        />
      </RadioGroup>
    </div>
  );
}

function AutomaticOption(props: {
  readonly record: AutoJudgeGetResponse | undefined;
  readonly pick: JudgePick;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly copilotEnabled: boolean;
}): ReactNode {
  const { record, pick } = props;
  const writing = pick.draft !== null && !pick.draft.awaitingModels;
  return (
    <JudgeOption
      value="automatic"
      label="Automatic"
      description="Traycer's hosted model when Traycer inference is available. Otherwise the conversation's own provider, billed to your account there."
    >
      <div className="flex min-w-0 items-center gap-2">
        {record !== undefined &&
        record.selection === null &&
        pick.draft === null ? (
          <AutomaticStatus record={record} harnesses={props.harnesses} />
        ) : null}
        {writing && pick.displayed === null ? <MutedAgentSpinner /> : null}
      </div>
      {props.copilotEnabled ? (
        <p className="text-ui-xs text-muted-foreground">
          Copilot conversations use premium requests when Traycer inference
          can&apos;t answer: {COPILOT_PREMIUM_REQUESTS_PER_HOUR} per hour of
          Auto mode.
        </p>
      ) : null}
    </JudgeOption>
  );
}

function SpecificOption(props: {
  /** Whether "A specific model" is the chosen option, so its fields show. */
  readonly open: boolean;
  readonly record: AutoJudgeGetResponse | undefined;
  readonly pick: JudgePick;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly disabled: boolean;
}): ReactNode {
  const { pick, providers } = props;
  const { displayed } = pick;
  const openProvider = useOpenJudgeProvider();
  const writing = pick.draft !== null && !pick.draft.awaitingModels;
  return (
    <JudgeOption
      value="specific"
      label="A specific model"
      description={
        displayed?.harnessId === COPILOT_HARNESS_ID
          ? `Billed to that provider's account, on top of the conversation itself. An hour of Auto mode can use ${COPILOT_PREMIUM_REQUESTS_PER_HOUR} premium requests.`
          : "Billed to that provider's account, on top of the conversation itself."
      }
    >
      {props.open ? (
        <>
          <JudgeModelField
            harnesses={props.harnesses}
            provider={
              displayed === null
                ? undefined
                : providerForHarness(providers, displayed.harnessId)
            }
            selection={displayed}
            models={pick.models}
            disabled={props.disabled}
            onProvider={(row) => {
              const next = providerPick({
                row,
                provider: providerForHarness(providers, row.id),
                models:
                  row.id === pick.displayedRow?.id ? pick.models : undefined,
              });
              pick.request(next.selection, next.awaitingModels);
            }}
            onAccount={(profileId) => {
              if (displayed === null) return;
              pick.request(
                { ...displayed, profileId },
                pick.draft?.awaitingModels ?? false,
              );
            }}
            onModel={(model) => {
              if (displayed === null) return;
              pick.request({ ...displayed, model }, false);
            }}
            onOpenProvider={openProvider}
          />
          <div className="flex min-w-0 items-center gap-2">
            <JudgeWarning
              record={props.record}
              saving={pick.draft !== null}
              harnesses={props.harnesses}
              models={pick.models}
              providers={providers}
              onOpenProvider={openProvider}
            />
            {writing && displayed !== null ? <MutedAgentSpinner /> : null}
          </div>
        </>
      ) : null}
    </JudgeOption>
  );
}

/** Providers ▸ {provider}, where a provider that cannot judge is fixed. */
function useOpenJudgeProvider(): (row: GuiHarnessOption) => void {
  const { openSettings } = useSystemTabModalActions();
  return (row) => {
    useProvidersFocusStore.getState().setFocusHarnessId(row.id);
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      // Settings is already scoped to this machine.
      hostId: null,
    });
  };
}

function JudgeOption(props: {
  readonly value: "automatic" | "specific";
  readonly label: string;
  readonly description: string;
  readonly children: ReactNode;
}): ReactNode {
  const id = useId();
  const descriptionId = useId();
  return (
    <div
      className="flex items-start gap-3 py-1"
      data-testid={`auto-judge-option-${props.value}`}
    >
      <RadioGroupItem
        value={props.value}
        id={id}
        aria-describedby={descriptionId}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor={id}>{props.label}</Label>
        <p id={descriptionId} className="text-ui-sm text-muted-foreground">
          {props.description}
        </p>
        {props.children}
      </div>
    </div>
  );
}

/**
 * What Automatic resolves to right now, from the host's `effective`. Silent
 * until the record has answered, and for a host too old to report it.
 *
 * `effective === null` is the one line for "nothing can run": whatever the
 * blocked reason, Automatic has no judge and Auto mode asks the user. Naming a
 * fix belongs to "A specific model", the only option a blocked reason is about.
 */
function AutomaticStatus(props: {
  readonly record: AutoJudgeGetResponse;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
}): ReactNode {
  const effective = props.record.effective;
  if (effective === undefined) return null;
  if (effective === null) {
    return (
      <span
        className="text-ui-sm text-warning-foreground"
        data-testid="auto-judge-effective"
      >
        No judge can run here · Auto mode asks you
      </span>
    );
  }
  if (effective.source === "fallback") {
    return (
      <span
        className="text-ui-sm text-muted-foreground"
        data-testid="auto-judge-effective"
      >
        Now: the conversation&apos;s own provider · your account
      </span>
    );
  }
  if (effective.source !== "default") return null;
  const row = props.harnesses?.find(
    (candidate) => candidate.id === effective.harnessId,
  );
  return (
    <span
      className="text-ui-sm text-muted-foreground"
      data-testid="auto-judge-effective"
    >
      Now:{" "}
      <span className="font-medium text-foreground">
        {row === undefined ? (
          effective.model
        ) : (
          <EffectiveModelLabel row={row} slug={effective.model} />
        )}{" "}
        on Traycer
      </span>{" "}
      · uses credits
    </span>
  );
}

function EffectiveModelLabel(props: {
  readonly row: GuiHarnessOption;
  readonly slug: string;
}): ReactNode {
  const models = useGuiHarnessModelsQuery(props.row.id, null, {
    enabled: true,
    subscribed: true,
  }).data?.models;
  return autoJudgeModelLabel(models, props.slug) ?? props.slug;
}

/** The first thing wrong with a stored judge, in the order it is reported. */
type JudgeWarningCause =
  | { readonly kind: "provider-disabled" }
  | { readonly kind: "unsupported-harness" }
  | { readonly kind: "unrecognized" }
  | { readonly kind: "provider"; readonly blocker: JudgeProviderBlocker }
  | { readonly kind: "model" }
  | { readonly kind: "profile" };

/**
 * The host's own `blocked` verdict first, then a harness this build does not
 * know, then what `autoJudgeRecordHealth` finds against the catalog. `null`
 * when the stored judge can run.
 */
function judgeWarningCause(input: {
  readonly record: AutoJudgeGetResponse;
  readonly stored: AutoJudgeSelection;
  readonly storedRow: GuiHarnessOption | undefined;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
}): JudgeWarningCause | null {
  const { stored, storedRow } = input;
  const blocked = input.record.blocked ?? null;
  if (blocked !== null) return { kind: blocked.reason };
  if (input.harnesses !== undefined && storedRow === undefined) {
    return { kind: "unrecognized" };
  }
  const health = autoJudgeRecordHealth({
    hasStoredSelection: true,
    unrecognizedHarnessId: null,
    isBlocked: false,
    saving: false,
    storedHarness: storedRow,
    storedModelSlug: stored.model,
    offeredModels: input.models,
    storedProfileId: stored.profileId,
    offeredProfileIds: offeredJudgeProfileIds(
      input.providers,
      stored.harnessId,
    ),
  });
  if (health.storedHarnessUnavailable && storedRow !== undefined) {
    const blocker = judgeProviderBlocker(storedRow);
    return blocker === null ? null : { kind: "provider", blocker };
  }
  if (health.storedModelUnavailable) return { kind: "model" };
  if (health.storedProfileUnavailable) return { kind: "profile" };
  return null;
}

/**
 * At most one amber line under the fields: the first thing wrong with the
 * stored record, in one sentence with one fix. `judgeWarningCause` decides;
 * this only chooses the sentence. Silent while a pick is in flight - the
 * record is about to change - and under Automatic, whose status line speaks
 * for it.
 */
function JudgeWarning(props: {
  readonly record: AutoJudgeGetResponse | undefined;
  readonly saving: boolean;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const { record } = props;
  const stored = record?.selection ?? null;
  if (record === undefined || stored === null || props.saving) return null;
  const storedRow = props.harnesses?.find((row) => row.id === stored.harnessId);
  const cause = judgeWarningCause({
    record,
    stored,
    storedRow,
    harnesses: props.harnesses,
    models: props.models,
    providers: props.providers,
  });
  if (cause === null) return null;
  const fixLink =
    storedRow === undefined ? (
      "Providers"
    ) : (
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        className="text-current underline"
        onClick={() => props.onOpenProvider(storedRow)}
      >
        Providers
      </Button>
    );
  return (
    <p
      className="min-w-0 text-pretty text-ui-sm text-warning-foreground"
      data-testid="auto-judge-warning"
    >
      <JudgeWarningSentence
        cause={cause}
        stored={stored}
        providerLabel={storedRow?.label ?? stored.harnessId}
        fixLink={fixLink}
      />
    </p>
  );
}

function JudgeWarningSentence(props: {
  readonly cause: JudgeWarningCause;
  readonly stored: AutoJudgeSelection;
  readonly providerLabel: string;
  readonly fixLink: ReactNode;
}): ReactNode {
  const { cause, providerLabel } = props;
  switch (cause.kind) {
    case "provider-disabled":
      return (
        <ProviderBlockerSentence
          label={providerLabel}
          blocker="Turned off"
          fixLink={props.fixLink}
        />
      );
    case "unsupported-harness":
      return `This machine can't run a judge on ${providerLabel}. Pick another provider.`;
    case "unrecognized":
      return `This machine's judge is set to ${props.stored.harnessId}, which this version of the app doesn't know. Pick another provider.`;
    case "provider":
      return (
        <ProviderBlockerSentence
          label={providerLabel}
          blocker={cause.blocker}
          fixLink={props.fixLink}
        />
      );
    case "model":
      return `${props.stored.model} is no longer offered on this machine. Pick another model, or Auto mode asks you instead.`;
    case "profile":
      return `The account this judge used was removed from ${providerLabel}. Pick another account, or Auto mode asks you instead.`;
  }
}

function ProviderBlockerSentence(props: {
  readonly label: string;
  readonly blocker: JudgeProviderBlocker;
  readonly fixLink: ReactNode;
}): ReactNode {
  switch (props.blocker) {
    case "Turned off":
      return (
        <>
          {props.label} is turned off on this machine. Turn it on under{" "}
          {props.fixLink}, or pick another.
        </>
      );
    case "Signed out":
      return (
        <>
          {props.label} is signed out on this machine. Sign in under{" "}
          {props.fixLink}, or pick another.
        </>
      );
    case "Not installed":
      return (
        <>
          {props.label} isn&apos;t installed on this machine. Install it under{" "}
          {props.fixLink}, or pick another.
        </>
      );
    case "Not available":
      return (
        <>
          {props.label} isn&apos;t available on this machine. Check it under{" "}
          {props.fixLink}, or pick another.
        </>
      );
  }
}

/**
 * "Providers with a built-in reviewer": one row per catalog row that can
 * review its own commands, each the same `ProviderJudgeSwitch` the provider's
 * own Permissions tab renders. Omitted when no such provider exists here.
 */
function BuiltInReviewers(): ReactNode {
  const harnesses = useGuiHarnessesQuery({ enabled: true, subscribed: true })
    .data?.harnesses;
  const providers = useProvidersList({ enabled: true, subscribed: true }).data
    ?.providers;
  const rows = (harnesses ?? []).flatMap((row) => {
    if (!row.nativeAutoJudge) return [];
    const state = providerForHarness(providers, row.id);
    return state === undefined ? [] : [{ row, state }];
  });
  if (rows.length === 0) return null;
  return (
    <SettingsGroup
      group={PERMISSIONS.definitions.builtInReviewers}
      showTitle
      tone="default"
      dataTestId="auto-judge-built-in-reviewers"
      fill={false}
    >
      <p className="px-5 pt-4 text-ui-sm text-muted-foreground">
        {PERMISSIONS.definitions.builtInReviewers.description}
      </p>
      {rows.map(({ row, state }) => (
        <div
          key={row.id}
          className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium text-foreground">{row.label}</div>
            <p className="text-ui-sm text-muted-foreground">
              Reviews with {classifierOwner(row.id, row.label)}&apos;s
              classifier, inside the conversation.
            </p>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[40%]">
            <ProviderJudgeSwitch key={state.providerId} state={state} />
          </div>
        </div>
      ))}
    </SettingsGroup>
  );
}

/**
 * Whose classifier a built-in reviewer is, as the row says it: Claude Code's
 * is Claude's (the spec's wording); any other provider's is its own.
 */
function classifierOwner(harnessId: string, label: string): string {
  return harnessId === providerIdToGuiHarnessId("claude-code")
    ? "Claude"
    : label;
}
