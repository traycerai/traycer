import { useState, type ReactNode } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { sandboxSupportReference } from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useConfigurationBillingUrl } from "@/hooks/sandboxes/use-configuration-billing-url";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatStopwatch } from "@/lib/format-duration";
import { useOpenLink } from "@/lib/links/open-link";
import { STAGED_TAKING_LONGER_MS } from "@/lib/sandboxes/staged-sandbox-run";
import { stageConfigurationCopy } from "@/lib/sandboxes/sandbox-stage-model";
import { sandboxSupportReferenceLine } from "@/lib/sandboxes/sandbox-row-lines";
import {
  ADD_CREDITS_LINK,
  CANCEL_AND_KEEP_THE_DRAFT,
  CANCEL_THE_MESSAGE,
  CHANGE_SHAPE_OR_REGION,
  CHOOSE_ANOTHER_HOST,
  CHOOSE_A_SMALLER_SHAPE,
  DETAILS,
  COMPUTE_CHARGED_WHILE_AWAKE,
  COPY_SUPPORT_REFERENCE,
  COULDNT_VERIFY_BALANCE,
  KEEP_WAITING,
  MESSAGE_STILL_PENDING,
  NOTHING_BILLED_NEVER_WOKE,
  NOTHING_CHARGED_FOR_WAKE,
  OPEN_TERMINAL,
  OPEN_TERMINAL_INSTEAD,
  RESUMING_SANDBOX,
  RESUMING_TAKING_LONGER,
  RETRY,
  RETRY_APPLYING,
  RETRY_CREATION,
  SANDBOXES_UNAVAILABLE,
  STARTING_SANDBOX,
  STARTING_TAKING_LONGER,
  STEP_BOOTING,
  STEP_CREATING,
  STEP_DELIVERING,
  STEP_RESUMING,
  STOP,
  configurationLabel,
  couldntResumeLine,
  couldntStartLine,
  sandboxCreditShortLine,
  shapeNotOfferedLine,
  readyButNotSentLine,
  readySecondsLabel,
  idleRuleLine,
  SANDBOX_READY,
  SANDBOX_AWAKE,
  agentNotOfferedOnSandboxesLine,
  agentsCantRunOnSandboxLine,
  traycerOffOnSandboxLine,
  settingsDidntApplyOnLine,
  stepApplyingSettings,
  takingLongerDetail,
} from "@/lib/sandboxes/sandbox-strings";
import { cn } from "@/lib/utils";
import type {
  StagedSandbox,
  StagedSandboxFailure,
  StagedSandboxStep,
} from "@/stores/composer/staged-sandbox-store";
import { sandboxAgentDisplayName } from "@/lib/sandboxes/sandbox-agent-refusal";
import { openActiveModelPickerForHarness } from "@/lib/commands/active-model-picker-registry";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import {
  sandboxSettingsFailureLine,
  sandboxSettingsStepsLine,
} from "@traycer/protocol/host/sandbox-settings";

/** The same ruled setup treatment and counter for a shell waiting on Automations. */
export function SandboxStartingLine(props: {
  readonly startedAt: number;
}): ReactNode {
  const seconds = useElapsedSeconds(props.startedAt, 0, null);
  return (
    <SandboxSetupLineFrame
      expanded={false}
      onToggle={null}
      trailing={null}
      head={
        <>
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
          <span>{`Starting Automations · ${formatStopwatch(seconds)}`}</span>
        </>
      }
    >
      {null}
    </SandboxSetupLineFrame>
  );
}

function SandboxSetupLineFrame(props: {
  readonly expanded: boolean;
  readonly onToggle: (() => void) | null;
  readonly head: ReactNode;
  readonly trailing: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const ChevronIcon = props.expanded ? ChevronDown : ChevronRight;
  return (
    <div
      className="flex w-full flex-col gap-1"
      data-testid="sandbox-setup-line"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        {props.onToggle === null ? (
          <div
            role="status"
            className="flex items-center gap-2 text-ui-xs text-muted-foreground"
          >
            {props.head}
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={props.expanded}
            data-testid="sandbox-setup-line-toggle"
            onClick={props.onToggle}
            className="flex items-center gap-2 rounded-sm text-ui-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {props.head}
            <ChevronIcon aria-hidden className="size-3 shrink-0" />
          </button>
        )}
        {props.trailing}
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {props.children}
    </div>
  );
}

/** What the line's buttons do, wired by the surface that owns the stage. */
export interface SandboxSetupLineActions {
  readonly onKeepWaiting: () => void;
  /** Before dispatch: Cancel and keep the draft; never destroys the sandbox. */
  readonly onCancel: (() => void) | null;
  readonly onChooseAnotherHost: (() => void) | null;
  /** A new create with a new key, after a terminal failure. */
  readonly onRetryCreation: () => void;
  /** The same create or wake again, with the same key. */
  readonly onRetry: () => void;
  /** The send handed to the ready sandbox, made again from its draft. */
  readonly onSendAgain: () => void;
  /** The shape sheet: Change shape or region, Choose a smaller shape. */
  readonly onChangeShape: (() => void) | null;
  /** Repairs the settings on the new host, then waits again. */
  readonly onRetryApplying: (() => void) | null;
  /** Guest-only repair on an older host; it does not acknowledge settings. */
  readonly onRepairSetup: (() => void) | null;
  readonly repairSetupPending?: boolean;
  readonly applyingPending?: boolean;
  readonly applyingError?: boolean;
  readonly onStop: (() => void) | null;
  /**
   * A folderless terminal on the new host: Open terminal on the Booting step
   * and the settings branch, Open terminal instead on the no-provider
   * refusal. `null` until the host can open one, or where the surface cannot.
   */
  readonly onOpenTerminal: (() => void) | null;
  readonly onChooseModel?: (() => void) | null;
}

/** The facts the line reads beyond the stage. */
export interface SandboxSetupLineFacts {
  /** The cost line of the staged shape, shown when the line is expanded. */
  readonly costLine: string;
  /** The region and shape, for the shape refusal. */
  readonly regionLabel: string;
  readonly shapeLabel: string;
  /** A cheaper shape the balance covers exists. */
  readonly smallerShapeAffordable: boolean;
  /** The agents sandboxes run, which Choose a model opens on; `null` unknown. */
  readonly offeredAgents: ReadonlyArray<string> | null;
  /** Whether the stage's sandbox is awake now; `null` before its row is listed. */
  readonly sandboxAwake: boolean | null;
  /**
   * The stage's sandbox is listed awake and no start or resume of it is
   * under way: Stop is offered only then.
   */
  readonly sandboxStoppable: boolean;
}

/**
 * The setup line a staged sandbox's first action draws above the draft
 * (the sandboxes plan): the worktree setup line's look (a hairline rule each
 * side, a spinner, `Starting sandbox · <name> · m:ss`, a chevron), driven by
 * the stage instead of persisted `setup.*` events, since no chat exists
 * before the host does. The elapsed counter is its only timing. A refusal
 * before anything was created is said in its place, above the draft, with
 * its remedies; the draft is kept on every branch.
 */
export function SandboxSetupLine(props: {
  readonly stage: StagedSandbox;
  /** The sandbox's name: the sheet's, else the one its create sends. */
  readonly name: string;
  readonly facts: SandboxSetupLineFacts;
  readonly actions: SandboxSetupLineActions;
  /** Only an undispatched send with exclusive ownership can be withdrawn. */
  readonly withdrawalAllowed?: boolean;
}): ReactNode {
  const { stage } = props;
  const actions =
    props.withdrawalAllowed === false
      ? {
          ...props.actions,
          onCancel: null,
          onChooseAnotherHost: null,
          onStop: null,
          onChangeShape: null,
        }
      : {
          ...props.actions,
          onStop:
            stage.createdSandboxId !== null && props.facts.sandboxStoppable
              ? props.actions.onStop
              : null,
        };
  const failure = stage.failure;
  if (failure !== null && isRefusal(failure)) {
    return (
      <SandboxRefusalLine
        stage={stage}
        name={props.name}
        failure={failure}
        facts={props.facts}
        actions={actions}
      />
    );
  }
  if (stage.phase === "staged" || stage.startedAt === null) return null;
  return (
    <SandboxProgressLine
      stage={stage}
      name={props.name}
      startedAt={stage.startedAt}
      facts={props.facts}
      actions={actions}
    />
  );
}

type RefusalFailure = Extract<
  StagedSandboxFailure,
  {
    readonly kind:
      | "credits"
      | "unverified"
      | "shape"
      | "unavailable"
      | "refused"
      | "no-provider"
      | "traycer-off"
      | "agent-not-offered"
      | "agent-setup-failed"
      | "not-sent";
  }
>;

function isRefusal(failure: StagedSandboxFailure): failure is RefusalFailure {
  return (
    failure.kind === "credits" ||
    failure.kind === "unverified" ||
    failure.kind === "shape" ||
    failure.kind === "unavailable" ||
    failure.kind === "refused" ||
    failure.kind === "no-provider" ||
    failure.kind === "traycer-off" ||
    failure.kind === "agent-not-offered" ||
    failure.kind === "agent-setup-failed" ||
    failure.kind === "not-sent"
  );
}

function SandboxRefusalLine(props: {
  readonly stage: StagedSandbox;
  readonly name: string;
  readonly failure: RefusalFailure;
  readonly facts: SandboxSetupLineFacts;
  readonly actions: SandboxSetupLineActions;
}): ReactNode {
  const { failure, actions } = props;
  const configuration = props.stage.target.configuration;
  const billingUrl = useConfigurationBillingUrl(configuration);
  const openLink = useOpenLink();
  let sentence: string;
  let remedies: ReactNode;
  switch (failure.kind) {
    case "credits":
      sentence = sandboxCreditShortLine(
        configuration,
        failure.creditSource ?? null,
        failure.shortfallMc,
        {
          waking: props.stage.target.kind === "existing",
          context: "sentence",
        },
      );
      remedies = (
        <>
          <LineButton
            label={ADD_CREDITS_LINK}
            testId="sandbox-refusal-add-credits"
            onClick={() => void openLink(billingUrl, "account", null)}
          />
          {props.facts.smallerShapeAffordable ? (
            <LineButton
              label={CHOOSE_A_SMALLER_SHAPE}
              testId="sandbox-refusal-smaller-shape"
              onClick={actions.onChangeShape}
            />
          ) : null}
        </>
      );
      break;
    case "unverified":
      sentence = COULDNT_VERIFY_BALANCE;
      remedies = (
        <LineButton
          label={RETRY}
          testId="sandbox-refusal-retry"
          onClick={actions.onRetry}
        />
      );
      break;
    case "shape":
      sentence = shapeNotOfferedLine(
        props.facts.regionLabel,
        props.facts.shapeLabel,
      );
      remedies = (
        <LineButton
          label={CHANGE_SHAPE_OR_REGION}
          testId="sandbox-refusal-change-shape"
          onClick={actions.onChangeShape}
        />
      );
      break;
    case "unavailable":
      sentence = SANDBOXES_UNAVAILABLE;
      remedies = (
        <LineButton
          label={RETRY}
          testId="sandbox-refusal-retry"
          onClick={actions.onRetry}
        />
      );
      break;
    case "refused":
      sentence = failure.message;
      remedies = null;
      break;
    case "no-provider":
    case "traycer-off":
    case "agent-not-offered":
    case "agent-setup-failed":
      sentence = agentRefusalSentence(failure, props.name);
      remedies = (
        <SandboxAgentRefusalRemedies
          actions={actions}
          offeredAgents={props.facts.offeredAgents}
        />
      );
      break;
    case "not-sent":
      // Kept: the draft is still there, and Retry hands it to the sandbox.
      sentence = readyButNotSentLine(props.name);
      remedies = (
        <LineButton
          label={RETRY}
          testId="sandbox-refusal-send-again"
          onClick={actions.onSendAgain}
        />
      );
      break;
  }
  return (
    <div
      role="alert"
      className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-ui-xs"
      data-testid="sandbox-refusal-line"
      data-refusal={failure.kind}
    >
      <span className="text-foreground/85">{sentence}</span>
      {remedies}
      <SandboxFailureExitActions
        stage={props.stage}
        actions={actions}
        prefix="sandbox-refusal"
      />
    </div>
  );
}

type AgentRefusalFailure = Extract<
  RefusalFailure,
  {
    readonly kind:
      | "no-provider"
      | "traycer-off"
      | "agent-not-offered"
      | "agent-setup-failed";
  }
>;

function agentRefusalSentence(
  failure: AgentRefusalFailure,
  name: string,
): string {
  switch (failure.kind) {
    case "agent-not-offered":
      return agentNotOfferedOnSandboxesLine(
        sandboxAgentDisplayName(failure.harnessId),
      );
    case "traycer-off":
      return traycerOffOnSandboxLine(name);
    case "no-provider":
      return agentsCantRunOnSandboxLine(name);
    case "agent-setup-failed":
      return failure.detail;
  }
}

/**
 * Remedies keep the sandbox and preserve the requested agent until the person
 * chooses: every agent refusal leads with Choose a model on what sandboxes
 * offer. Traycer Inference is that sandbox's own switch, and no Settings page
 * reaches it, so no refusal links a Providers page.
 */
function SandboxAgentRefusalRemedies(props: {
  readonly actions: SandboxSetupLineActions;
  readonly offeredAgents: ReadonlyArray<string> | null;
}): ReactNode {
  const { actions, offeredAgents } = props;
  if (actions.onChooseModel === null) return null;
  return (
    <LineButton
      label="Choose a model"
      testId="sandbox-refusal-choose-model"
      onClick={
        actions.onChooseModel ??
        (() => {
          openActiveModelPickerForHarness("traycer", null, offeredAgents);
        })
      }
    />
  );
}

/** Shared exits never change a sandbox when the person withdraws the message. */
function SandboxFailureExitActions(props: {
  readonly stage: StagedSandbox;
  readonly actions: SandboxSetupLineActions;
  readonly prefix: "sandbox-refusal" | "sandbox-setup";
}): ReactNode {
  const { actions } = props;
  const sandboxId = props.stage.createdSandboxId;
  return (
    <>
      {props.stage.failure?.kind === "credits" ? null : (
        <LineButton
          label={OPEN_TERMINAL_INSTEAD}
          testId={`${props.prefix}-open-terminal`}
          onClick={actions.onOpenTerminal}
        />
      )}
      <LineButton
        label={CHOOSE_ANOTHER_HOST}
        testId={`${props.prefix}-choose-another-host`}
        onClick={actions.onChooseAnotherHost}
      />
      <LineButton
        label={CANCEL_THE_MESSAGE}
        testId={`${props.prefix}-cancel`}
        onClick={actions.onCancel}
      />
      {sandboxId === null ? null : (
        <LineButton
          label={DETAILS}
          testId={`${props.prefix}-details`}
          onClick={() => openSandboxDetails(sandboxId)}
        />
      )}
    </>
  );
}

function SandboxProgressLine(props: {
  readonly stage: StagedSandbox;
  readonly name: string;
  readonly startedAt: number;
  readonly facts: SandboxSetupLineFacts;
  readonly actions: SandboxSetupLineActions;
}): ReactNode {
  const { stage } = props;
  const failure = stage.failure;
  const resuming =
    stage.target.kind === "existing" ||
    (failure?.kind === "failed" && failure.code === "wake");
  const name = props.name;
  const configuration = configurationLabel(
    stageConfigurationCopy(stage.target.configuration),
  );
  const elapsedSeconds = useElapsedSeconds(props.startedAt, 0, null);
  const takingLonger = isTakingLonger(failure, elapsedSeconds);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? (failure !== null || takingLonger);
  const view: ProgressView = {
    stage,
    failure,
    resuming,
    configuration,
    takingLonger,
    sandboxAwake: props.facts.sandboxAwake,
    sandboxStoppable: props.facts.sandboxStoppable,
  };
  return (
    <SandboxSetupLineFrame
      expanded={expanded}
      onToggle={() => setManualExpanded(!expanded)}
      trailing={
        <LineButton
          label={STOP}
          testId="sandbox-setup-stop"
          onClick={
            failure?.kind === "settings" && expanded
              ? null
              : props.actions.onStop
          }
        />
      }
      head={
        <ProgressHead view={view} name={name} elapsedSeconds={elapsedSeconds} />
      }
    >
      {expanded ? (
        <ProgressDetail
          view={view}
          facts={props.facts}
          actions={props.actions}
        />
      ) : null}
    </SandboxSetupLineFrame>
  );
}

/** What the line's parts read of the stage. */
interface ProgressView {
  readonly stage: StagedSandbox;
  readonly failure: StagedSandboxFailure | null;
  readonly resuming: boolean;
  readonly configuration: string;
  readonly takingLonger: boolean;
  readonly sandboxAwake: boolean | null;
  readonly sandboxStoppable: boolean;
}

function isTakingLonger(
  failure: StagedSandboxFailure | null,
  elapsedSeconds: number,
): boolean {
  if (failure !== null) return failure.kind === "timed-out";
  return elapsedSeconds * 1000 >= STAGED_TAKING_LONGER_MS;
}

/** The run is still going: no failure, or only the budget ran out. */
function stillWaiting(failure: StagedSandboxFailure | null): boolean {
  return failure === null || failure.kind === "timed-out";
}

function progressTitle(view: ProgressView, name: string): string {
  const { failure, resuming } = view;
  if (failure?.kind === "failed") {
    return resuming ? couldntResumeLine(name) : couldntStartLine(name);
  }
  if (failure?.kind === "settings") {
    const reference = sandboxSupportReference(failure.code) ?? "SBX-0520";
    return view.sandboxAwake === false
      ? settingsDidntApplyOnLine(view.configuration, name, reference)
      : sandboxSettingsFailureLine(name, view.configuration, reference);
  }
  if (view.sandboxStoppable) return SANDBOX_AWAKE;
  if (view.takingLonger) {
    return resuming ? RESUMING_TAKING_LONGER : STARTING_TAKING_LONGER;
  }
  return resuming ? RESUMING_SANDBOX : STARTING_SANDBOX;
}

function ProgressHead(props: {
  readonly view: ProgressView;
  readonly name: string;
  readonly elapsedSeconds: number;
}): ReactNode {
  const { failure } = props.view;
  const waiting = stillWaiting(failure);
  const code = failureCode(failure);
  // A failure's title already names the sandbox.
  const namesSandbox =
    failure?.kind !== "failed" && failure?.kind !== "settings";
  return (
    <>
      {waiting ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : (
        <AlertCircle
          aria-hidden
          className="size-3.5 shrink-0 text-destructive"
        />
      )}
      <span className="text-foreground/85">
        {progressTitle(props.view, props.name)}
      </span>
      {namesSandbox ? <HeadPart text={props.name} /> : null}
      {code === null || failure?.kind === "settings" ? null : (
        <HeadPart text={code} />
      )}
      {waiting ? (
        <HeadPart text={formatStopwatch(props.elapsedSeconds)} />
      ) : null}
    </>
  );
}

function HeadPart(props: { readonly text: string }): ReactNode {
  return (
    <>
      <span aria-hidden className="text-muted-foreground/40">
        ·
      </span>
      <span className="text-muted-foreground/80">{props.text}</span>
    </>
  );
}

function ProgressDetail(props: {
  readonly view: ProgressView;
  readonly facts: SandboxSetupLineFacts;
  readonly actions: SandboxSetupLineActions;
}): ReactNode {
  const { stage, failure, resuming, configuration } = props.view;
  return (
    // muted-fill-ok: the line renders on the composer's canvas, not a raised surface
    <div
      className="mx-auto flex w-full flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-ui-xs text-muted-foreground"
      data-testid="sandbox-setup-line-detail"
    >
      {failure?.kind === "settings" ? null : (
        <p className="m-0">{props.facts.costLine}</p>
      )}
      {props.view.takingLonger && stage.stepAt !== null ? (
        <TakingLongerDetail
          step={stage.step}
          stepAt={stage.stepAt}
          resuming={resuming}
          configuration={configuration}
        />
      ) : null}
      <FailureSentence
        failure={failure}
        resuming={resuming}
        sandboxAwake={props.view.sandboxAwake}
      />
      {failure?.kind === "settings" ? (
        <>
          <p className="m-0">
            {sandboxSettingsStepsLine(
              failure.steps ?? { applied: [], notApplied: [] },
            )}
          </p>
          {stage.sendTaken ? (
            <p className="m-0">Your message waits until they apply.</p>
          ) : null}
          {props.actions.applyingError ? (
            <p role="alert">Settings still didn't apply · SBX-0520</p>
          ) : null}
        </>
      ) : null}
      <SetupSteps
        step={stage.step}
        failure={failure}
        resuming={resuming}
        configuration={configuration}
        onOpenTerminal={failure === null ? props.actions.onOpenTerminal : null}
      />
      <div className="flex flex-wrap gap-2">
        <ProgressBranchButtons view={props.view} actions={props.actions} />
      </div>
    </div>
  );
}

function FailureSentence(props: {
  readonly failure: StagedSandboxFailure | null;
  readonly resuming: boolean;
  readonly sandboxAwake: boolean | null;
}): ReactNode {
  if (props.failure?.kind === "failed") {
    // A sandbox that failed after it woke was charged while it was awake.
    if (stepAfterWake(props.failure.step)) {
      return <p className="m-0">{COMPUTE_CHARGED_WHILE_AWAKE}</p>;
    }
    return (
      <p className="m-0">
        {props.resuming
          ? NOTHING_CHARGED_FOR_WAKE
          : `${NOTHING_BILLED_NEVER_WOKE}. ${MESSAGE_STILL_PENDING}`}
      </p>
    );
  }
  if (props.failure?.kind === "settings" && props.sandboxAwake !== false) {
    return <p className="m-0">{COMPUTE_CHARGED_WHILE_AWAKE}</p>;
  }
  return null;
}

function ProgressBranchButtons(props: {
  readonly view: ProgressView;
  readonly actions: SandboxSetupLineActions;
}): ReactNode {
  const { actions } = props;
  const { failure, resuming } = props.view;
  if (failure?.kind === "failed") {
    return (
      <FailedButtons
        stage={props.view.stage}
        failure={failure}
        resuming={resuming}
        actions={actions}
      />
    );
  }
  if (failure?.kind === "settings") {
    return (
      <>
        {props.view.stage.createdSandboxId === null ? null : (
          <>
            <LineButton
              label={RETRY_APPLYING}
              testId="sandbox-setup-retry-applying"
              onClick={actions.onRetryApplying}
              pending={actions.applyingPending}
            />
            <LineButton
              label="Repair setup"
              testId="sandbox-setup-repair-setup"
              onClick={actions.onRepairSetup}
              pending={actions.repairSetupPending}
            />
          </>
        )}
        <LineButton
          label={OPEN_TERMINAL}
          testId="sandbox-setup-open-terminal"
          onClick={actions.onOpenTerminal}
        />
        <LineButton
          label={STOP}
          testId="sandbox-setup-stop"
          onClick={actions.onStop}
        />
        <LineButton
          label={CHOOSE_ANOTHER_HOST}
          testId="sandbox-setup-choose-another-host"
          onClick={actions.onChooseAnotherHost}
        />
        {props.view.stage.sendTaken ? (
          <LineButton
            label={CANCEL_THE_MESSAGE}
            testId="sandbox-setup-cancel"
            onClick={actions.onCancel}
          />
        ) : null}
        {props.view.stage.createdSandboxId === null ? null : (
          <LineButton
            label={DETAILS}
            testId="sandbox-setup-details"
            onClick={() => {
              const sandboxId = props.view.stage.createdSandboxId;
              if (sandboxId !== null) openSandboxDetails(sandboxId);
            }}
          />
        )}
      </>
    );
  }
  if (failure?.kind === "timed-out") {
    return (
      <>
        <LineButton
          label={KEEP_WAITING}
          testId="sandbox-setup-keep-waiting"
          onClick={actions.onKeepWaiting}
        />
        <SandboxFailureExitActions
          stage={props.view.stage}
          actions={actions}
          prefix="sandbox-setup"
        />
      </>
    );
  }
  if (!props.view.takingLonger) return null;
  return (
    <>
      <LineButton
        label={KEEP_WAITING}
        testId="sandbox-setup-keep-waiting"
        onClick={actions.onKeepWaiting}
      />
      <LineButton
        label={CANCEL_AND_KEEP_THE_DRAFT}
        testId="sandbox-setup-cancel"
        onClick={actions.onCancel}
      />
      <LineButton
        label={CHOOSE_ANOTHER_HOST}
        testId="sandbox-setup-choose-another-host"
        onClick={actions.onChooseAnotherHost}
      />
    </>
  );
}

function FailedButtons(props: {
  readonly stage: StagedSandbox;
  readonly failure: Extract<StagedSandboxFailure, { readonly kind: "failed" }>;
  readonly resuming: boolean;
  readonly actions: SandboxSetupLineActions;
}): ReactNode {
  const { actions, resuming } = props;
  const clipboard = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  // The failed row's id goes in the reference, for support to find it.
  const supportReference = sandboxSupportReferenceLine(
    props.failure.code,
    props.stage.createdSandboxId,
  );
  return (
    <>
      {resuming ? (
        <LineButton
          label={RETRY}
          testId="sandbox-setup-retry"
          onClick={actions.onRetry}
        />
      ) : (
        <LineButton
          label={RETRY_CREATION}
          testId="sandbox-setup-retry-creation"
          onClick={actions.onRetryCreation}
        />
      )}
      <SandboxFailureExitActions
        stage={props.stage}
        actions={actions}
        prefix="sandbox-setup"
      />
      <LineButton
        label={COPY_SUPPORT_REFERENCE}
        testId="sandbox-setup-copy-reference"
        onClick={() => clipboard.copy(supportReference)}
      />
    </>
  );
}

/** The failure's support reference for the line, never its raw code. */
function failureCode(failure: StagedSandboxFailure | null): string | null {
  if (failure === null) return null;
  if (failure.kind === "failed" || failure.kind === "settings") {
    return sandboxSupportReference(failure.code);
  }
  return null;
}

function stepLabel(
  step: StagedSandboxStep,
  resuming: boolean,
  configuration: string,
): string {
  switch (step) {
    case "creating":
      return STEP_CREATING;
    case "booting":
      return resuming ? STEP_RESUMING : STEP_BOOTING;
    case "applying":
      return stepApplyingSettings(configuration);
    case "delivering":
      return STEP_DELIVERING;
  }
}

function TakingLongerDetail(props: {
  readonly step: StagedSandboxStep;
  readonly stepAt: number;
  readonly resuming: boolean;
  readonly configuration: string;
}): ReactNode {
  const age = useElapsedSeconds(props.stepAt, 0, null);
  return (
    <p className="m-0">
      {takingLongerDetail(
        stepLabel(props.step, props.resuming, props.configuration),
        formatStopwatch(age),
        stepAfterWake(props.step),
      )}
    </p>
  );
}

/** The sandbox had woken by this step, so its compute was being charged. */
function stepAfterWake(step: StagedSandboxStep): boolean {
  return step === "applying" || step === "delivering";
}

const STEP_ORDER: readonly StagedSandboxStep[] = [
  "creating",
  "booting",
  "applying",
  "delivering",
];

function SetupSteps(props: {
  readonly step: StagedSandboxStep;
  readonly failure: StagedSandboxFailure | null;
  readonly resuming: boolean;
  readonly configuration: string;
  readonly onOpenTerminal: (() => void) | null;
}): ReactNode {
  // A wake has no create step.
  const steps = props.resuming
    ? STEP_ORDER.filter((step) => step !== "creating")
    : STEP_ORDER;
  const current = steps.indexOf(props.step);
  const failedStep = failedStepOf(props.failure);
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {steps.map((step, index) => {
        const failed = step === failedStep;
        const done = !failed && index < current;
        const active = !failed && index === current && props.failure === null;
        return (
          <li
            key={step}
            className={cn(
              "flex items-center gap-2",
              done || active || failed ? "text-foreground/85" : undefined,
            )}
            data-testid={`sandbox-setup-step-${step}`}
          >
            {done ? (
              <Check
                aria-hidden
                className="size-3.5 shrink-0 text-success-foreground"
              />
            ) : null}
            {failed ? (
              <AlertCircle
                aria-hidden
                className="size-3.5 shrink-0 text-destructive"
              />
            ) : null}
            {active ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {!done && !failed && !active ? (
              <span aria-hidden className="size-3.5 shrink-0" />
            ) : null}
            {stepLabel(step, props.resuming, props.configuration)}
            {step === "booting" && props.onOpenTerminal !== null ? (
              <LineButton
                label={OPEN_TERMINAL}
                testId="sandbox-setup-booting-open-terminal"
                onClick={props.onOpenTerminal}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function LineButton(props: {
  readonly label: string;
  readonly testId: string;
  readonly onClick: (() => void) | null;
  readonly pending?: boolean;
}): ReactNode {
  if (props.onClick === null) return null;
  return (
    <Button
      type="button"
      variant="link"
      size="inline-xs"
      data-testid={props.testId}
      onClick={props.onClick}
      disabled={props.pending}
    >
      {props.label}
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </Button>
  );
}

/** The step a failure stopped at: settings fail at applying. */
function failedStepOf(
  failure: StagedSandboxFailure | null,
): StagedSandboxStep | null {
  if (failure === null) return null;
  if (failure.kind === "settings") return "applying";
  if (failure.kind === "failed") return failure.step;
  return null;
}

/**
 * The setup line once the message was handed to the agent:
 * `Sandbox ready · name · 24 s`, collapsed, above the
 * chat's first message. Expanded, the idle rule with the sandbox's own idle
 * period, once its row says it.
 */
export function SandboxReadyLine(props: {
  readonly name: string;
  readonly readySeconds: number;
  /** The sandbox's idle period in minutes; `null` until its row is read. */
  readonly idleMinutes: number | null;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;
  return (
    <div
      className="flex w-full flex-col gap-1 px-3 py-2"
      data-testid="sandbox-ready-line"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="sandbox-ready-line-toggle"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 rounded-sm text-ui-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Check
            aria-hidden
            className="size-3.5 shrink-0 text-success-foreground"
          />
          <span className="text-foreground/85">{SANDBOX_READY}</span>
          <HeadPart text={props.name} />
          <HeadPart text={readySecondsLabel(props.readySeconds)} />
          <ChevronIcon aria-hidden className="size-3 shrink-0" />
        </button>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {expanded && props.idleMinutes !== null ? (
        <p
          className="m-0 text-center text-ui-xs text-muted-foreground"
          data-testid="sandbox-ready-line-detail"
        >
          {idleRuleLine(props.idleMinutes)}
        </p>
      ) : null}
    </div>
  );
}

/** The message waiting behind the setup line, as the person sent it. */
export function PendingSandboxMessage(props: {
  readonly text: string;
}): ReactNode {
  return (
    <div
      className="flex w-full justify-end"
      data-testid="pending-sandbox-message"
    >
      <p className="m-0 max-w-full whitespace-pre-wrap break-words rounded-md border border-border/60 px-3 py-2 text-ui-sm text-foreground">
        {props.text}
      </p>
    </div>
  );
}
