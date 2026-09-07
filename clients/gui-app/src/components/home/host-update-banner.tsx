import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useHostBinding } from "@/lib/host/runtime";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  BusyContinuation,
  HostControllerStatus,
  IHostManagement,
  MutationLaneStatus,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRunnerApplyStaged } from "@/hooks/runner/use-runner-apply-staged-mutation";
import { useRunnerActivateInstalled } from "@/hooks/runner/use-runner-activate-installed-mutation";
import {
  HOST_UPDATE_BANNER_SNOOZE_MS,
  HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS,
  isHostUpdateBannerSnoozed,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  useLocalHostUpdateOperation,
  UNBOUND_LOCAL_UPDATE_OPERATION,
  type LocalHostUpdateOperation,
} from "@/hooks/host/use-local-host-update-operation";
import {
  isQuietUpdateView,
  offersForceRestart,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import {
  describeUpdateOperation,
  operationProgressBytes,
  operationProgressPercent,
  showsProgressBar,
  type UpdateOperationCopy,
} from "@/components/home/host-update-operation-copy";
import { LocalHostRestartFlow } from "@/components/host/local-host-restart-flow";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";

interface HostUpdateBannerProps {
  readonly className: string | undefined;
}

// `pendingActivation`/`activationUnknown` render identically ("debt"); `"unavailable"` never renders debt UI
// here.
const ACTIVATION_DEBT_STATES: ReadonlySet<string> = new Set([
  "pendingActivation",
  "activationUnknown",
]);

/** Driven entirely by the canonical two-lane `HostControllerStatus` - never the raw registry probe. */
export function HostUpdateBanner(props: HostUpdateBannerProps) {
  const runnerHost = useRunnerHost();
  const binding = useHostBinding();
  const management = runnerHost.hostManagement;
  if (management === null) {
    return null;
  }
  // That is a truthful answer for a client with no host runtime: it still knows a stage is ready or that
  // activation is owed, and it correctly claims nothing about an attempt it cannot read.
  return binding === null ? (
    <HostUpdateBannerInner
      management={management}
      className={props.className}
      localUpdate={UNBOUND_LOCAL_UPDATE_OPERATION}
    />
  ) : (
    <BoundHostUpdateBanner
      management={management}
      className={props.className}
    />
  );
}

function BoundHostUpdateBanner(props: {
  readonly management: IHostManagement;
  readonly className: string | undefined;
}) {
  const localUpdate = useLocalHostUpdateOperation();
  return (
    <HostUpdateBannerInner
      management={props.management}
      className={props.className}
      localUpdate={localUpdate}
    />
  );
}

interface HostUpdateBannerInnerProps {
  readonly management: IHostManagement;
  readonly className: string | undefined;
  readonly localUpdate: LocalHostUpdateOperation;
}

type BannerIntent = "apply" | "activate";

interface BusyState {
  readonly intent: BannerIntent;
  readonly continuation: BusyContinuation;
  readonly message: string;
}

interface TerminalOutcomeState {
  readonly intent: BannerIntent;
  readonly message: string;
}

function HostUpdateBannerInner(props: HostUpdateBannerInnerProps) {
  const { className } = props;
  const snoozeUntilByVersion = useHostUpdateBannerStore(
    (state) => state.snoozeUntilByVersion,
  );
  const snooze = useHostUpdateBannerStore((state) => state.snooze);

  const statusQuery = useRunnerHostControllerStatusQuery();
  const status = statusQuery.data;

  // The durable attempt, which outranks the two-lane controller status below whenever it has something to say.
  const localUpdate = props.localUpdate;
  const localEntry = useReactiveLocalHostEntry();
  const localHostName = localEntry?.label ?? "This computer";
  // Drives the shared local restart flow: cooperative `host.restart` first (which re-asks the host about live
  // work and answers with its current busy verdict), then the existing confirmation.
  const [forceRestartRequested, setForceRestartRequested] = useState(false);

  const [busy, setBusy] = useState<BusyState | null>(null);
  const [terminalOutcome, setTerminalOutcome] =
    useState<TerminalOutcomeState | null>(null);

  const applyStagedMutation = useRunnerApplyStaged();
  const activateInstalledMutation = useRunnerActivateInstalled();
  const dismissLandingAttempt = useHostUpdateBannerStore(
    (state) => state.dismissLandingAttempt,
  );
  // Taking a router dependency here is deliberate: the failure copy has always pointed at Diagnostics, and
  // pointing somewhere the user cannot get to from the pointer is the gap this closes.
  const { openSettings } = useSystemTabModalActions();

  const handleApplyOutcome = (
    outcome: MutationOutcome<ApplyStagedOk>,
  ): void => {
    applyMutationOutcome("apply", outcome, {
      setBusy,
      setTerminalOutcome,
      onOk: (value) => {
        toast.success(`Updated host to v${value.appliedVersion}`);
        useHostUpdateBannerStore.getState().clearSnooze(value.appliedVersion);
      },
    });
  };

  const handleActivateOutcome = (
    outcome: MutationOutcome<ActivateInstalledOk>,
  ): void => {
    applyMutationOutcome("activate", outcome, {
      setBusy,
      setTerminalOutcome,
      onOk: () => {
        toast.success("Host activated");
      },
    });
  };

  const runApply = (force: boolean): void => {
    Analytics.getInstance().track(AnalyticsEvent.HostUpdateStarted, {
      source: "direct_ui",
    });
    applyStagedMutation.mutate(
      { trigger: "manual", force },
      { onSuccess: handleApplyOutcome },
    );
  };

  const runActivate = (force: boolean): void => {
    Analytics.getInstance().track(AnalyticsEvent.HostUpdateStarted, {
      source: "direct_ui",
    });
    activateInstalledMutation.mutate(
      { force },
      { onSuccess: handleActivateOutcome },
    );
  };

  const nowMs = useHostUpdateNowMs();

  // Update-over-debt priority (Tech Plan): a ready update supersedes
  // activation debt outright, since applying the new bytes activates them.
  const { showUpdate, showDebt, hostDown, offeredVersion, installedVersion } =
    deriveOfferedVersion(status);
  const snoozed =
    terminalOutcome === null &&
    offeredVersion !== null &&
    isHostUpdateBannerSnoozed(snoozeUntilByVersion, offeredVersion, nowMs);

  // So a detached attempt that failed left a dead-end banner on the landing page for the whole retention
  // lifetime of the record, and a completed one simply never went away.
  const dismissedAttemptIds = useHostUpdateBannerStore(
    (state) => state.landingDismissedAttemptIds,
  );
  useLandingCompletionCollapse(localUpdate.view);
  const showOperation =
    operationSupersedesControllerStatus(
      localUpdate.view,
      showUpdate || showDebt,
    ) && !isLandingDismissed(localUpdate.view, dismissedAttemptIds);
  const shouldShow = useMemo(
    () =>
      showOperation ||
      terminalOutcome !== null ||
      ((showUpdate || showDebt) && offeredVersion !== null && !snoozed),
    [
      showOperation,
      terminalOutcome,
      showUpdate,
      showDebt,
      offeredVersion,
      snoozed,
    ],
  );

  const mutationLane = status?.mutation ?? null;
  const percent = deriveActivePercent(
    mutationLane,
    applyStagedMutation.isPending,
    activateInstalledMutation.isPending,
  );

  if (!shouldShow) {
    return null;
  }

  // Disables off the mutation lane only (never the download lane).
  const isPending =
    applyStagedMutation.isPending ||
    activateInstalledMutation.isPending ||
    mutationLane !== null;

  const handleForce = (): void => {
    resolveForceAction(busy, runApply, runActivate);
  };

  const forceDialogProps = deriveForceDialogProps(busy);
  const operationCopy = describeUpdateOperation({
    view: localUpdate.view,
    hostName: localHostName,
  });

  // Naming the branch is the structural fix: there is now no way to derive a property from a branch that is not
  // on screen, because there is only one expression that decides which branch that is.
  const branch = resolveBannerBranch({
    showOperation,
    hasTerminalOutcome: terminalOutcome !== null,
  });
  const showsFailure =
    branch === "operation"
      ? localUpdate.view.kind === "failed"
      : branch === "terminal-outcome";
  const bannerAriaLabel =
    branch === "operation"
      ? operationCopy.accessibleLabel
      : deriveBannerAriaLabel(terminalOutcome, offeredVersion);
  // Destructive styling tracks the FACT, from whichever source is speaking: a
  // terminal mutation outcome, or an attempt the host reports as failed.
  const bannerClassName = deriveBannerClassName(showsFailure, className);

  return (
    <>
      {/* The shared local restart flow, mounted unconditionally so the banner never owns a second restart path. The
         banner only sets `requested`. */}
      <LocalHostRestartFlow
        requested={forceRestartRequested}
        onClose={() => {
          setForceRestartRequested(false);
        }}
      />
      <HostBusyForceDeferDialog
        open={busy !== null}
        message={forceDialogProps.message}
        isForcing={isPending}
        forceLabel={forceDialogProps.forceLabel}
        onForce={handleForce}
        onDefer={() => {
          setBusy(null);
        }}
      />
      <output
        aria-label={bannerAriaLabel}
        data-testid="host-update-banner"
        // It must never go back to consulting one lane's copy while the other lane is on screen.
        aria-live={showsFailure ? "assertive" : "polite"}
        className={bannerClassName}
      >
        <BannerBody
          branch={branch}
          view={localUpdate.view}
          copy={operationCopy}
          terminalOutcome={terminalOutcome}
          isPending={isPending}
          showUpdate={showUpdate}
          offeredVersion={offeredVersion}
          installedVersion={installedVersion}
          percent={percent}
          onForceRestart={() => {
            setForceRestartRequested(true);
          }}
          onOperationRetry={() => {
            // The second half is the fix: `showDebt` is `!updateReady && activation ∈ {pendingActivation,
            // activationUnknown}`, and `deriveActivationState` returns `unavailable` - in neither set.
            if (showDebt || hostDown) {
              runActivate(false);
              return;
            }
            runApply(false);
          }}
          onDiagnostics={() => {
            openSettings({ section: "diagnostics", resetToGeneral: false });
          }}
          onOperationDismiss={dismissLandingAttempt}
          onTerminalRetry={() => {
            if (terminalOutcome === null) return;
            setTerminalOutcome(null);
            if (terminalOutcome.intent === "apply") {
              runApply(false);
            } else {
              runActivate(false);
            }
          }}
          onTerminalDismiss={() => {
            setTerminalOutcome(null);
          }}
          onAction={() => {
            if (showUpdate) {
              runApply(false);
            } else {
              runActivate(false);
            }
          }}
          onSnooze={() => {
            if (offeredVersion === null) return;
            snooze(offeredVersion, getHostUpdateSnoozeUntilMs());
            Analytics.getInstance().track(AnalyticsEvent.HostUpdateSnoozed, {
              source: "direct_ui",
            });
          }}
        />
      </output>
    </>
  );
}

/** It remains useful last-known context in Settings, but it is not an operation and must not raise the landing
 * update banner merely because startup temporarily made that quiet read stale. */
function operationSupersedesControllerStatus(
  view: FleetUpdateView,
  controllerHasConcreteFact: boolean,
): boolean {
  // `isQuietUpdateView` is the shared "nothing to show" predicate - the Overview hides its operation card on the
  // same test, so the two surfaces agree on where quiet begins.
  if (isQuietUpdateView(view)) return false;
  if (view.kind === "unknown") return !controllerHasConcreteFact;
  return true;
}

type BannerBranch = "operation" | "terminal-outcome" | "update-or-debt";

function resolveBannerBranch(input: {
  readonly showOperation: boolean;
  readonly hasTerminalOutcome: boolean;
}): BannerBranch {
  if (input.showOperation) return "operation";
  if (input.hasTerminalOutcome) return "terminal-outcome";
  return "update-or-debt";
}

interface BannerBodyProps {
  readonly branch: BannerBranch;
  readonly view: FleetUpdateView;
  readonly copy: UpdateOperationCopy;
  readonly terminalOutcome: TerminalOutcomeState | null;
  readonly isPending: boolean;
  readonly showUpdate: boolean;
  readonly offeredVersion: string | null;
  readonly installedVersion: string | null;
  readonly percent: number | null;
  readonly onForceRestart: () => void;
  readonly onOperationRetry: () => void;
  readonly onDiagnostics: () => void;
  readonly onOperationDismiss: (attemptId: string) => void;
  readonly onTerminalRetry: () => void;
  readonly onTerminalDismiss: () => void;
  readonly onAction: () => void;
  readonly onSnooze: () => void;
}

/** A `switch` rather than the chained ternary this replaced, and separated from the wrapper so that the element
 * carrying `aria-live`. */
function BannerBody(props: BannerBodyProps) {
  switch (props.branch) {
    case "operation":
      return (
        <OperationContent
          view={props.view}
          copy={props.copy}
          onForceRestart={props.onForceRestart}
          onRetry={props.onOperationRetry}
          onDiagnostics={props.onDiagnostics}
          onDismiss={props.onOperationDismiss}
        />
      );
    case "terminal-outcome":
      return props.terminalOutcome === null ? null : (
        <TerminalOutcomeContent
          terminalOutcome={props.terminalOutcome}
          isPending={props.isPending}
          onRetry={props.onTerminalRetry}
          onDismiss={props.onTerminalDismiss}
        />
      );
    case "update-or-debt":
      return (
        <UpdateOrDebtContent
          showUpdate={props.showUpdate}
          offeredVersion={props.offeredVersion}
          installedVersion={props.installedVersion}
          isPending={props.isPending}
          percent={props.percent}
          onAction={props.onAction}
          onSnooze={props.onSnooze}
        />
      );
  }
}

/** A terminal attempt the landing banner has finished with. */
function isLandingDismissed(
  view: FleetUpdateView,
  dismissedAttemptIds: ReadonlyArray<string>,
): boolean {
  if (view.kind !== "complete" && view.kind !== "failed") return false;
  const attemptId = view.attemptId;
  return attemptId !== null && dismissedAttemptIds.includes(attemptId);
}

/** The dismissal it writes is the same one the failure path uses, so "collapsed" and "dismissed" cannot drift
 * into two different notions of hidden. */
function useLandingCompletionCollapse(view: FleetUpdateView): void {
  const dismissLandingAttempt = useHostUpdateBannerStore(
    (state) => state.dismissLandingAttempt,
  );
  const completedAttemptId = view.kind === "complete" ? view.attemptId : null;
  useEffect(() => {
    if (completedAttemptId === null) return;
    const timer = setTimeout(() => {
      dismissLandingAttempt(completedAttemptId);
    }, HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [completedAttemptId, dismissLandingAttempt]);
}

interface OperationContentProps {
  readonly view: FleetUpdateView;
  readonly copy: UpdateOperationCopy;
  readonly onForceRestart: () => void;
  readonly onRetry: () => void;
  readonly onDiagnostics: () => void;
  readonly onDismiss: (attemptId: string) => void;
}

/** Update state is not a host-action mutex (plan §4), and the user is never required to clear or dismiss this
 * banner before recovering the host. */
function OperationContent(props: OperationContentProps) {
  const { view } = props;
  const percent = operationProgressPercent(view);
  const bytes = operationProgressBytes(view);
  const showProgress = showsProgressBar(view);
  const failedAttemptId = view.kind === "failed" ? view.attemptId : null;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1" data-testid="host-update-banner-phase">
          {props.copy.primary}
          {/* Freshness, stated rather than implied. A qualified view is the last thing we knew, not what is true now, and
             the doc requires it be marked honestly rather than presented as live. */}
          {props.copy.needsQualifiedMarker ? (
            <span
              className="ml-1 opacity-70"
              data-testid="host-update-banner-qualified"
            >
              (last known)
            </span>
          ) : null}
        </span>
        {bytes === null ? null : (
          <span
            className="shrink-0 font-mono text-code-xs tabular-nums opacity-80"
            data-testid="host-update-banner-progress-bytes"
          >
            {bytes}
          </span>
        )}
        {percent !== null ? (
          <span
            className="shrink-0 font-mono text-code-xs tabular-nums"
            data-testid="host-update-banner-progress-percent"
          >
            {percent}%
          </span>
        ) : null}
        {view.kind === "failed" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={props.onRetry}
            data-testid="host-update-banner-operation-retry"
          >
            Retry
          </Button>
        ) : null}
        {/* Diagnostics for the two states the contract points there: a failure (its "Retry. */}
        {view.kind === "failed" || view.kind === "unavailable" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={props.onDiagnostics}
            data-testid="host-update-banner-operation-diagnostics"
          >
            Diagnostics
          </Button>
        ) : null}
        {offersForceRestart(view) ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            className="shrink-0"
            onClick={props.onForceRestart}
            data-testid="host-update-banner-force-restart"
          >
            {/* This click only arms the shared restart flow, which re-asks the host about live work and then requires the
               existing modal. It never restarts on the first click. */}
            Force restart…
          </Button>
        ) : null}
        {/* Dismiss exists only for a failure, and only once there is an attempt id to remember it by. */}
        {failedAttemptId === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            className="text-current hover:bg-destructive/15 hover:text-current"
            onClick={() => {
              props.onDismiss(failedAttemptId);
            }}
            data-testid="host-update-banner-operation-dismiss"
          >
            <X className="size-3" aria-hidden />
          </Button>
        )}
      </div>
      {showProgress ? (
        <UpdateProgressBar
          percent={percent}
          label={props.copy.accessibleLabel}
          className={undefined}
        />
      ) : null}
    </div>
  );
}

interface MutationOutcomeActions<TOk> {
  readonly setBusy: (busy: BusyState | null) => void;
  readonly setTerminalOutcome: (outcome: TerminalOutcomeState | null) => void;
  readonly onOk: (value: TOk) => void;
}

function applyMutationOutcome<TOk>(
  intent: BannerIntent,
  outcome: MutationOutcome<TOk>,
  actions: MutationOutcomeActions<TOk>,
): void {
  if (outcome.kind === "ok") {
    Analytics.getInstance().track(AnalyticsEvent.HostUpdateSucceeded, null);
    actions.onOk(outcome.value);
    actions.setBusy(null);
    actions.setTerminalOutcome(null);
    return;
  }
  if (outcome.kind === "busy") {
    actions.setBusy({
      intent,
      continuation: outcome.continuation,
      message: outcome.message,
    });
    return;
  }
  Analytics.getInstance().track(AnalyticsEvent.HostUpdateFailed, {
    blocker: "unknown",
  });
  actions.setBusy(null);
  actions.setTerminalOutcome({ intent, message: outcome.message });
}

function resolveForceAction(
  busy: BusyState | null,
  runApply: (force: boolean) => void,
  runActivate: (force: boolean) => void,
): void {
  if (busy === null) return;
  if (busy.continuation === "activate" || busy.intent === "activate") {
    runActivate(true);
    return;
  }
  runApply(true);
}

function deriveOfferedVersion(status: HostControllerStatus | undefined): {
  readonly showUpdate: boolean;
  readonly showDebt: boolean;
  /** Retry routing only - never banner visibility. See `onOperationRetry`. */
  readonly hostDown: boolean;
  readonly offeredVersion: string | null;
  readonly installedVersion: string | null;
} {
  if (status === undefined) {
    return {
      showUpdate: false,
      showDebt: false,
      hostDown: false,
      offeredVersion: null,
      installedVersion: null,
    };
  }
  const showUpdate = status.updateReady;
  const showDebt =
    !status.updateReady && ACTIVATION_DEBT_STATES.has(status.activation);
  // `ACTIVATION_DEBT_STATES` gates banner visibility across several surfaces, and `unavailable` is the ordinary
  // state during every healthy swap window.
  const hostDown = !status.updateReady && status.activation === "unavailable";
  let offeredVersion: string | null = null;
  if (showUpdate) {
    offeredVersion = status.stagedVersion;
  } else if (showDebt) {
    offeredVersion = status.installedVersion;
  }
  return {
    showUpdate,
    showDebt,
    hostDown,
    offeredVersion,
    installedVersion: status.installedVersion,
  };
}

interface ForceDialogProps {
  readonly message: string;
  readonly forceLabel: string;
}

function deriveForceDialogProps(busy: BusyState | null): ForceDialogProps {
  if (busy === null) {
    return { message: "", forceLabel: "Force update" };
  }
  return {
    message: busy.message,
    forceLabel:
      busy.continuation === "activate" ? "Force restart" : "Force update",
  };
}

function deriveBannerAriaLabel(
  terminalOutcome: TerminalOutcomeState | null,
  offeredVersion: string | null,
): string {
  if (terminalOutcome !== null) {
    return `Traycer host update failed: ${terminalOutcome.message}`;
  }
  return `Traycer host update available: ${offeredVersion ?? ""}`;
}

function deriveBannerClassName(
  destructive: boolean,
  className: string | undefined,
): string {
  const stateClassName = destructive
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-100";
  return cn(
    "flex items-center gap-2 rounded-md border px-3 py-2 text-ui-sm",
    stateClassName,
    className,
  );
}

function deriveActivePercent(
  mutationLane: MutationLaneStatus | null,
  applyPending: boolean,
  activatePending: boolean,
): number | null {
  if (applyPending && mutationLane?.kind === "apply") {
    return mutationLane.progress?.percent ?? null;
  }
  if (activatePending && mutationLane?.kind === "activate") {
    return mutationLane.progress?.percent ?? null;
  }
  return null;
}

interface TerminalOutcomeContentProps {
  readonly terminalOutcome: TerminalOutcomeState;
  readonly isPending: boolean;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

function TerminalOutcomeContent(props: TerminalOutcomeContentProps) {
  return (
    <>
      <span
        className="min-w-0 flex-1"
        data-testid="host-update-banner-deferred"
      >
        {props.terminalOutcome.message}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.isPending}
        onClick={props.onRetry}
        data-testid="host-update-banner-retry"
      >
        Retry
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="text-current hover:bg-destructive/15 hover:text-current"
        onClick={props.onDismiss}
      >
        <X className="size-3" aria-hidden />
      </Button>
    </>
  );
}

interface UpdateOrDebtContentProps {
  readonly showUpdate: boolean;
  readonly offeredVersion: string | null;
  readonly installedVersion: string | null;
  readonly isPending: boolean;
  readonly percent: number | null;
  readonly onAction: () => void;
  readonly onSnooze: () => void;
}

function UpdateOrDebtContent(props: UpdateOrDebtContentProps) {
  return (
    <>
      <ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {props.showUpdate ? (
          <>
            A new Traycer host is available:{" "}
            <span className="font-mono">{props.offeredVersion}</span>
            {props.installedVersion !== null ? (
              <>
                {" "}
                (installed:{" "}
                <span className="font-mono">{props.installedVersion}</span>)
              </>
            ) : null}
            .
          </>
        ) : (
          "Update installed — restart host to finish."
        )}
      </span>
      <Button
        type="button"
        size="sm"
        variant="default"
        disabled={props.isPending}
        onClick={props.onAction}
        data-testid="host-update-banner-action"
      >
        {props.isPending ? (
          <>
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
            {props.percent !== null ? (
              <span
                className="mr-2 font-mono text-code-xs tabular-nums"
                data-testid="host-update-banner-progress-percent"
              >
                {Math.max(0, Math.min(100, Math.round(props.percent)))}%
              </span>
            ) : null}
          </>
        ) : null}
        {props.showUpdate ? "Update now" : "Restart host"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Remind me later"
        data-testid="host-update-banner-snooze"
        className="text-current hover:bg-sky-500/15 hover:text-current"
        onClick={props.onSnooze}
      >
        <X className="size-3" aria-hidden />
      </Button>
    </>
  );
}

function useHostUpdateNowMs(): number {
  const [nowMs] = useState(() => Date.now());
  return nowMs;
}

function getHostUpdateSnoozeUntilMs(): number {
  return Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS;
}
