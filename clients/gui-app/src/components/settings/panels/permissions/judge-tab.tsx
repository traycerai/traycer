/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import {
  readableModelMatch,
  resolveModelBySlug,
} from "@traycer/protocol/host/agent/gui/model-slug-resolution";
import {
  effectiveJudgeReasoningEffort,
  sortReasoningEffortOptions,
} from "@traycer/protocol/host/agent/gui/reasoning-effort-order";
import { SettingsGroup } from "@/components/settings/settings-group";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useAutoJudgeQuery,
  useAutoJudgeVerdict,
} from "@/hooks/auto-mode/use-auto-judge-query";
import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import { autoJudgeModelLabel } from "@/hooks/auto-mode/use-auto-judge-billing";
import {
  useHostMethodSchemaVersion,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import {
  useGuiHarnessModelsQuery,
  useGuiHarnessesQuery,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { PERMISSIONS } from "@/components/settings/panels/permissions-settings.definitions";
import {
  defaultJudgeModelFor,
  firstOfferedJudgeProfileId,
  judgeModelsFailedLine,
  judgeNoModelsLine,
  judgeProviderBlocker,
  judgeSelectionForProvider,
  judgeWarningCause,
  offeredJudgeProfileIds,
  providerForHarness,
  type JudgeProviderBlocker,
  type JudgeWarningCause,
} from "@/components/settings/panels/auto-judge-selection";
import {
  AutoModeHostGate,
  AutoModeUnsupportedLine,
} from "@/components/settings/panels/permissions/auto-mode-host-gate";
import { JudgeModelField } from "@/components/settings/panels/permissions/judge-model-field";
import { ProviderJudgeSwitch } from "@/components/settings/panels/permissions/provider-judge-switch";
import {
  autoJudgeGetKnowsReasoningEffort,
  autoJudgeSetStoresReasoningEffort,
  COPILOT_PREMIUM_REQUESTS_PER_HOUR,
} from "@/lib/auto-mode/auto-judge-billing";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const PREDATES_AUTO_MODE =
  "This machine's host predates Auto mode. Update it to choose a judge and write a policy.";

/** A typed harness id for the models query while no provider is chosen. */
const IDLE_MODELS_HARNESS_ID = providerIdToGuiHarnessId("traycer");

const COPILOT_HARNESS_ID = providerIdToGuiHarnessId("copilot");

/**
 * The chosen model's own advertised efforts, resolved the same way the rest
 * of this tab resolves a stored slug (`resolveModelBySlug`, which also
 * matches an entitlement-decorated alias), in the CANONICAL low-to-high order
 * (`sortReasoningEffortOptions`) rather than a harness's own catalog order -
 * Grok's live catalog lists Extra High first, and this field's first option
 * is always named as the default, so it has to be the one the host actually
 * runs by default. Empty while the catalog has not answered or the slug
 * matches nothing in it.
 */
function effortOptionsForModel(
  models: ReadonlyArray<GuiAgentModelOption> | undefined,
  modelSlug: string,
): ReadonlyArray<AgentReasoningEffortOption> {
  if (models === undefined) return [];
  const row = readableModelMatch(resolveModelBySlug(models, modelSlug));
  if (row === null) return [];
  return sortReasoningEffortOptions(row.supportedReasoningEfforts);
}

/**
 * The stored effort as the Effort field shows it: the stored id while the
 * model still advertises it, else `null`, which the field paints as its
 * "Default (<lowest>)" option. That is what the host runs for such an id
 * (`effectiveJudgeReasoningEffort` falls back to the lowest advertised), and
 * a `Select` whose value matches no item would paint an empty trigger instead.
 */
function storedEffortIfOffered(
  effortOptions: ReadonlyArray<AgentReasoningEffortOption>,
  stored: string | null,
): string | null {
  if (stored === null) return null;
  return effortOptions.some((option) => option.id === stored) ? stored : null;
}

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
 *
 * A pick whose `model` is `""` is UNCOMMITTED: a provider chosen before its
 * default model is known. It is on screen and never sent - the contract
 * refuses an empty model - until its catalog names one, and choosing an
 * account for it keeps it uncommitted.
 */
interface JudgeDraft {
  readonly id: number;
  readonly selection: AutoJudgeSelection | null;
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
  /** The displayed provider's catalog read failed, so `models` is not coming. */
  readonly modelsFailed: boolean;
  /** The latest pick is waiting on a model and has not been sent. */
  readonly uncommitted: boolean;
  readonly request: (selection: AutoJudgeSelection | null) => void;
}

function isUncommitted(draft: JudgeDraft | null): boolean {
  return draft?.selection?.model === "";
}

/**
 * An uncommitted pick commits the moment its catalog names a model. The same
 * draft when nothing changes, so the render-phase adjustment settles; a
 * catalog that answers with nothing leaves it uncommitted, and the tab says so.
 */
function resolveAwaitedDraft(input: {
  readonly draft: JudgeDraft | null;
  readonly row: GuiHarnessOption | undefined;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
}): JudgeDraft | null {
  const { draft, row } = input;
  const selection = draft?.selection ?? null;
  if (draft === null || selection === null || row === undefined) return draft;
  if (selection.model !== "") return draft;
  const model = defaultJudgeModelFor(row, input.models);
  return model === null
    ? draft
    : { ...draft, selection: { ...selection, model } };
}

/**
 * The pick a provider choice makes: its default model when one is known now,
 * else the provider alone, uncommitted until its catalog answers.
 */
function providerPick(input: {
  readonly row: GuiHarnessOption;
  readonly provider: ProviderCliState | undefined;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
}): AutoJudgeSelection {
  return (
    judgeSelectionForProvider(input) ?? {
      harnessId: input.row.id,
      model: "",
      profileId: firstOfferedJudgeProfileId(input.provider),
      // Uncommitted (empty model), so there is no model to run an effort
      // against yet either; the field resolves it once the catalog answers.
      reasoningEffort: null,
    }
  );
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
 * An uncommitted pick is never dispatched, so nothing here can send `""`.
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
  const modelsFailed =
    displayedRow !== undefined && models === undefined && modelsQuery.isError;

  // Adjusted during render rather than in an effect, so the draft never shows
  // an empty model for a frame after the catalog is known.
  const resolved = resolveAwaitedDraft({ draft, row: displayedRow, models });
  if (resolved !== draft) setDraft(resolved);

  const mutateJudge = setJudge.mutate;
  const dispatched = useRef(new Set<number>());
  useEffect(() => {
    if (draft === null || isUncommitted(draft)) return;
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

  const request = (selection: AutoJudgeSelection | null): void => {
    lastDraftId.current += 1;
    setDraft({ id: lastDraftId.current, selection });
  };
  return {
    draft,
    displayed,
    displayedRow,
    models,
    modelsFailed,
    uncommitted: isUncommitted(draft),
    request,
  };
}

/**
 * The Auto mode judge: Automatic, or a specific provider, account and model.
 * Only a record that has not loaded yet (a pick would overwrite a selection
 * this window has not seen) or a host that cannot store one disables it.
 */
function AutoJudgeControls(props: {
  readonly hostId: string | null;
}): ReactNode {
  // Two readers of one record. The SELECTION is shown whatever its age - the
  // picker hands off to it - while the VERDICT (`effective`, `blocked`) is
  // withheld from the moment it is invalidated until a re-read lands. That is
  // the composer's rule, so Settings and the composer never name different
  // accounts.
  const query = useAutoJudgeQuery();
  const verdict = useAutoJudgeVerdict();
  const canWrite = useHostSupportsMethod(props.hostId, "autoJudge.set");
  // Two gates on two lines, as the composer draws them: the Effort FIELD writes
  // through `set`, so it needs a `set` line that stores the effort; the "Now:"
  // LABEL reports what `get`'s host runs, so it needs a `get` line whose host
  // applies one.
  const judgeSetVersion = useHostMethodSchemaVersion(
    props.hostId,
    "autoJudge.set",
  );
  const judgeGetVersion = useHostMethodSchemaVersion(
    props.hostId,
    "autoJudge.get",
  );
  const showEffort = autoJudgeSetStoresReasoningEffort(judgeSetVersion);
  const hostRunsEffort = autoJudgeGetKnowsReasoningEffort(judgeGetVersion);
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  const harnesses = harnessesQuery.data?.harnesses;
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
      {/* The Provider field stays disabled without its catalog, and every
          finding about the stored judge past the host's own verdict waits on
          it too; an errored query refetches on its next mount. */}
      {harnesses === undefined && harnessesQuery.isError ? (
        <p
          className="text-ui-sm font-medium text-warning-foreground"
          data-testid="auto-judge-providers-error"
        >
          Couldn&apos;t load this machine&apos;s providers. Reopen Settings to
          try again.
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
            if (pick.displayed !== null) pick.request(null);
          } else if (next === "specific") {
            setSpecificChosen(true);
          }
        }}
      >
        <AutomaticOption
          verdict={verdict}
          pick={pick}
          harnesses={harnesses}
          copilotEnabled={
            providers?.some(
              (provider) =>
                provider.providerId === "copilot" && provider.enabled,
            ) ?? false
          }
          hostRunsEffort={hostRunsEffort}
        />
        <SpecificOption
          open={mode === "specific"}
          verdict={verdict}
          pick={pick}
          harnesses={harnesses}
          providers={providers}
          disabled={disabled}
          showEffort={showEffort}
        />
      </RadioGroup>
    </div>
  );
}

function AutomaticOption(props: {
  /** The CURRENT record, or `undefined` while it has none: see the caller. */
  readonly verdict: AutoJudgeGetResponse | undefined;
  readonly pick: JudgePick;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly copilotEnabled: boolean;
  /** See `AutomaticStatus.hostRunsEffort`. */
  readonly hostRunsEffort: boolean;
}): ReactNode {
  const { verdict, pick } = props;
  const writing = pick.draft !== null && !pick.uncommitted;
  return (
    <JudgeOption
      value="automatic"
      label="Automatic"
      description="Traycer's hosted model when Traycer inference is available. Otherwise the conversation's own provider, billed to your account there."
    >
      <div className="flex min-w-0 items-center gap-2">
        {verdict !== undefined &&
        verdict.selection === null &&
        pick.draft === null ? (
          <AutomaticStatus
            record={verdict}
            harnesses={props.harnesses}
            hostRunsEffort={props.hostRunsEffort}
          />
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
  /**
   * The CURRENT record, or `undefined` while it has none. The warning line
   * reports the host's `blocked` verdict first, so it waits with it.
   */
  readonly verdict: AutoJudgeGetResponse | undefined;
  readonly pick: JudgePick;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly disabled: boolean;
  /** Whether the host's negotiated `autoJudge.set` can store an effort. */
  readonly showEffort: boolean;
}): ReactNode {
  const { pick, providers } = props;
  const { displayed } = pick;
  const openProvider = useOpenJudgeProvider();
  const writing = pick.draft !== null && !pick.uncommitted;
  const cause = storedJudgeCause({
    record: props.verdict,
    pick,
    harnesses: props.harnesses,
    providers,
  });
  const effortOptions =
    displayed === null
      ? []
      : effortOptionsForModel(pick.models, displayed.model);
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
            modelsFailed={pick.modelsFailed}
            effortOptions={effortOptions}
            effort={storedEffortIfOffered(
              effortOptions,
              displayed?.reasoningEffort ?? null,
            )}
            showEffort={props.showEffort}
            openProvidersFor={openProvidersTarget(pick, cause)}
            disabled={props.disabled}
            onProvider={(row) => {
              pick.request(
                providerPick({
                  row,
                  provider: providerForHarness(providers, row.id),
                  models:
                    row.id === pick.displayedRow?.id ? pick.models : undefined,
                }),
              );
            }}
            onAccount={(profileId) => {
              if (displayed !== null) pick.request({ ...displayed, profileId });
            }}
            onModel={(model) => {
              if (displayed === null) return;
              // Keep the picked effort only while the NEW model still offers
              // that id - one valid for the old model and not for this one
              // would otherwise be sent and then silently dropped at
              // resolution, which is the defect the reset avoids.
              const efforts = effortOptionsForModel(pick.models, model);
              const storedEffort = displayed.reasoningEffort;
              const keepsEffort =
                storedEffort !== null &&
                efforts.some((option) => option.id === storedEffort);
              pick.request({
                ...displayed,
                model,
                reasoningEffort: keepsEffort ? storedEffort : null,
              });
            }}
            onEffort={(effort) => {
              if (displayed !== null) {
                pick.request({ ...displayed, reasoningEffort: effort });
              }
            }}
            onOpenProvider={openProvider}
          />
          <div className="flex min-w-0 items-center gap-2">
            <UncommittedPickLine pick={pick} />
            <JudgeWarning
              cause={cause}
              stored={props.verdict?.selection ?? null}
              harnesses={props.harnesses}
              onOpenProvider={openProvider}
            />
            {writing && displayed !== null ? <MutedAgentSpinner /> : null}
          </div>
        </>
      ) : null}
    </JudgeOption>
  );
}

/**
 * What is wrong with the stored judge, or `null` - also while a pick is on
 * screen, since the record is about to change or is not what the controls
 * show, and while the record's verdict is not current (`record` is then
 * `undefined`): the host's `blocked` comes first in the order, so no later
 * finding can be named as the first until it is known. `judgeWarningCause`
 * decides.
 */
function storedJudgeCause(input: {
  readonly record: AutoJudgeGetResponse | undefined;
  readonly pick: JudgePick;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
}): JudgeWarningCause | null {
  const stored = input.record?.selection ?? null;
  if (input.record === undefined || stored === null) return null;
  if (input.pick.draft !== null) return null;
  return judgeWarningCause({
    stored,
    blocked: input.record.blocked ?? null,
    harnesses: input.harnesses,
    // With no pick on screen the displayed provider IS the stored one.
    offeredModels: input.pick.models,
    offeredProfileIds: offeredJudgeProfileIds(
      input.providers,
      stored.harnessId,
    ),
  });
}

/**
 * The provider the Provider field's "Open Providers" link opens: the displayed
 * one while it cannot run here, unless the warning line already links there.
 */
function openProvidersTarget(
  pick: JudgePick,
  cause: JudgeWarningCause | null,
): GuiHarnessOption | null {
  const row = pick.displayedRow;
  if (row === undefined || judgeProviderBlocker(row) === null) return null;
  const warningLinks =
    cause?.kind === "provider" || cause?.kind === "provider-disabled";
  return warningLinks ? null : row;
}

/**
 * The line under an uncommitted pick once its catalog has spoken: a read that
 * failed, or a provider with no model to judge on. Silent while it loads - the
 * Model field says "Loading models…" then, and only then.
 */
function UncommittedPickLine(props: { readonly pick: JudgePick }): ReactNode {
  const { pick } = props;
  const row = pick.displayedRow;
  if (!pick.uncommitted || row === undefined) return null;
  if (!pick.modelsFailed && pick.models === undefined) return null;
  return (
    <p
      className="min-w-0 text-pretty text-ui-sm text-warning-foreground"
      data-testid="auto-judge-pick-warning"
    >
      {pick.modelsFailed
        ? judgeModelsFailedLine(row.label)
        : judgeNoModelsLine(row.label)}
    </p>
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
  /**
   * Whether this host runs the judge at an effort of its own (its
   * `autoJudge.get` line is `1.2` or later). Below it the host runs the
   * model's default and the label must not name an effort the host does not
   * apply - the composer's rule too.
   */
  readonly hostRunsEffort: boolean;
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
          <EffectiveModelLabel
            row={row}
            slug={effective.model}
            // Always `null`: this line only renders under Automatic, which
            // has no stored selection, so there is no picked effort - the
            // host runs its default for the model, the lowest it advertises.
            reasoningEffort={null}
            hostRunsEffort={props.hostRunsEffort}
          />
        )}{" "}
        on Traycer
      </span>{" "}
      · uses credits
    </span>
  );
}

/**
 * The effective judge's model label, with the reasoning effort the host runs
 * it at appended in parentheses - e.g. "Grok 4.7 Build Fast (Low)". That is
 * `reasoningEffort` while the model still advertises it, else the host's
 * default for the model: the lowest effort it advertises. Silent about effort
 * only when there is none to name: the model advertises no efforts, its
 * catalog has not answered, or the host predates judge efforts.
 */
function EffectiveModelLabel(props: {
  readonly row: GuiHarnessOption;
  readonly slug: string;
  readonly reasoningEffort: string | null;
  readonly hostRunsEffort: boolean;
}): ReactNode {
  const models = useGuiHarnessModelsQuery(props.row.id, null, {
    enabled: true,
    subscribed: true,
  }).data?.models;
  const modelLabel = autoJudgeModelLabel(models, props.slug) ?? props.slug;
  // The same resolution the host itself runs (`effectiveJudgeReasoningEffort`):
  // the stored effort when the model still advertises it, else the model's
  // own lowest - so this label and the host's actual run never disagree.
  const effortLabel =
    models === undefined || !props.hostRunsEffort
      ? null
      : (effectiveJudgeReasoningEffort(
          models,
          props.slug,
          props.reasoningEffort,
        )?.label ?? null);
  return effortLabel === null ? modelLabel : `${modelLabel} (${effortLabel})`;
}

/**
 * At most one amber line under the fields: the first thing wrong with the
 * stored record, in one sentence with one fix. `judgeWarningCause` decides;
 * this only chooses the sentence.
 */
function JudgeWarning(props: {
  readonly cause: JudgeWarningCause | null;
  readonly stored: AutoJudgeSelection | null;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly onOpenProvider: (row: GuiHarnessOption) => void;
}): ReactNode {
  const { cause, stored } = props;
  if (cause === null || stored === null) return null;
  const storedRow = props.harnesses?.find((row) => row.id === stored.harnessId);
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
