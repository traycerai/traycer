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

// `pendingActivation`/`activationUnknown` render identically ("debt");
// `"unavailable"` never renders debt UI here - that ambiguous state is the
// gate's domain, not a banner affordance (Renderer surfaces cutover ticket).
const ACTIVATION_DEBT_STATES: ReadonlySet<string> = new Set([
  "pendingActivation",
  "activationUnknown",
]);

/**
 * In-app host update / activation-debt banner (Host Update Layer Redesign
 * Tech Plan, D4). Driven entirely by the canonical two-lane
 * `HostControllerStatus` - never the raw registry probe - so it never shows
 * for a merely-detected update, only once a stage is `updateReady` or the
 * host carries activation debt. A ready update supersedes debt (applying new
 * bytes activates them too), so the two never render together.
 */
export function HostUpdateBanner(props: HostUpdateBannerProps) {
  const runnerHost = useRunnerHost();
  const binding = useHostBinding();
  const management = runnerHost.hostManagement;
  if (management === null) {
    return null;
  }
  // SPLIT ON THE BINDING, exactly as `LocalHostRestartFlow` does and for the
  // same reason: reading the durable attempt needs a host client, and
  // `useHostClient()` THROWS without a mounted `<HostRuntimeProvider>` rather
  // than returning null. Hooks cannot be called conditionally, so the branch
  // has to be a component boundary.
  //
  // The unbound arm is not a degraded stub — it is today's shipped banner,
  // driven by the two-lane `HostControllerStatus` alone. That is a truthful
  // answer for a client with no host runtime: it still knows a stage is ready
  // or that activation is owed, and it correctly claims nothing about an
  // attempt it cannot read.
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

/** The bound arm: identical banner, plus the durable attempt. */
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

  // The DURABLE attempt, which outranks the two-lane controller status below
  // whenever it has something to say. The controller lane knows this client
  // started a mutation; the attempt knows what is actually happening on the
  // host, survives this window closing, and names its phase. See
  // `operationSupersedesControllerStatus` for exactly when it wins.
  const localUpdate = props.localUpdate;
  const localEntry = useReactiveLocalHostEntry();
  const localHostName = localEntry?.label ?? "This computer";
  // Drives the SHARED local restart flow: cooperative `host.restart` first
  // (which re-asks the host about live work and answers with its current busy
  // verdict), then the existing confirmation. See the Force restart… handler.
  const [forceRestartRequested, setForceRestartRequested] = useState(false);

  const [busy, setBusy] = useState<BusyState | null>(null);
  const [terminalOutcome, setTerminalOutcome] =
    useState<TerminalOutcomeState | null>(null);

  const applyStagedMutation = useRunnerApplyStaged();
  const activateInstalledMutation = useRunnerActivateInstalled();
  const dismissLandingAttempt = useHostUpdateBannerStore(
    (state) => state.dismissLandingAttempt,
  );
  // The canonical in-app route to a Settings section, the same one the menu and
  // tray bridges use. Taking a router dependency here is deliberate: the
  // failure copy has always pointed at Diagnostics, and pointing somewhere the
  // user cannot get to from the pointer is the gap this closes.
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

  // An attempt that is doing something is NOT snoozable and does not wait for
  // the controller lane to agree — "active, parked, or reconnecting operations
  // cannot be snoozed away" (experience doc), and a parked
  // `waiting-to-activate` is precisely the state a person needs to see.
  //
  // A TERMINAL attempt is different, and used to be treated the same. A rich
  // `failed`/`complete` view superseded the controller status like every other
  // non-idle kind, but the branch it superseded INTO rendered no terminal
  // lifecycle at all — no Retry, no Diagnostics, no dismiss for a failure, no
  // acknowledgement for a success. The controller lane's own terminal branch
  // has all of those, and a rich attempt could never reach it. So a detached
  // attempt that failed left a dead-end banner on the landing page for the
  // whole retention lifetime of the record, and a completed one simply never
  // went away.
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

  // Disables off the mutation lane only (never the download lane) - and off
  // the SHARED lane, not just this banner's own mutations, so a mutation
  // started from Settings, the tray/menu, or the background auto-update
  // reconciler disables this banner's button too (the exclusive mutation
  // lane can only run one intent system-wide at a time).
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

  // THE RENDERED BRANCH, AS A VALUE — computed once and read by the markup, the
  // label, the styling and the live region alike.
  //
  // These were four parallel ternaries over the same two conditions, and one of
  // them disagreed with the other three. `aria-live` derived its politeness from
  // `describeUpdateOperation(localUpdate.view)` unconditionally, so when the
  // controller lane rendered a FAILURE the local rich view was typically
  // `idle`/`unknown`, `assertive` was false, and a failed apply was announced
  // politely — while the visible text, the accessible label and the destructive
  // styling all correctly said "failed". A screen-reader user got the one
  // rendering that had quietly kept reading a branch nobody was looking at.
  //
  // Naming the branch is the structural fix: there is now no way to derive a
  // property from a branch that is not on screen, because there is only one
  // expression that decides which branch that is.
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
      {/*
        The SHARED local restart flow, mounted unconditionally so the banner
        never owns a second restart path. It re-asks the host about live work
        (cooperative `host.restart`), renders the existing busy/force
        confirmation, and runs its forced respawn under the same mutation key
        every other restart gate watches — which is what "through the existing
        confirmation modal to the attempt-aware restart boundary" means. The
        banner only sets `requested`.
      */}
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
        // Polite for ordinary phase changes, assertive for a failure — the
        // experience doc's accessibility rule. `aria-live` on the same element
        // as `aria-label` is what makes each phase transition announce itself
        // rather than only being readable on focus.
        //
        // Reads `showsFailure`, which is derived from the branch actually
        // rendered. It must never go back to consulting one lane's copy while
        // the other lane is on screen.
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
            // A `failed` view does not carry the phase it failed in — the
            // projection's `failed` arms set `lastKnownKind: null` — so the
            // attempt itself cannot say whether bytes still need applying or
            // only activating, and the controller lane has to decide.
            //
            // Activate when the machine owes an activation OR when the host is
            // DOWN. The second half is the fix: `showDebt` is
            // `!updateReady && activation ∈ {pendingActivation,
            // activationUnknown}`, and `deriveActivationState` returns
            // `unavailable` — in neither set — whenever there is no running
            // runtime identity. A packaged-macOS activation that fails after
            // bootout leaves exactly that state, so the one case this routing
            // was added for took the apply arm and re-ran `applyStaged` against
            // a stage the failed attempt had already consumed. The recovery
            // button did not recover, on a machine whose host was not running.
            //
            // `hostDown` is a SEPARATE flag rather than a wider
            // `ACTIVATION_DEBT_STATES`, because that set also gates banner
            // visibility and `unavailable` is the ordinary state during every
            // healthy swap — widening it would raise a debt banner on each
            // restart.
            //
            // Apply stays the default for everything else, including a healthy
            // `activated` host with no ready stage: an attempt that failed
            // during download has nothing staged to activate, and apply is the
            // retry that re-runs the download. Routing that case to activate
            // would restart an already-correct host to no purpose.
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

/**
 * Whether the durable attempt has something to say that outranks the two-lane
 * controller status.
 *
 * `idle` does NOT: the host looked and there is no attempt, so the controller's
 * "a stage is ready" / "activation debt" answer is the more useful one.
 *
 * Everything concrete wins — including `unavailable`, whose whole point is to
 * stay visible rather than read as a quiet host.
 *
 * `unknown` SPLITS, and used to be rejected outright.
 *
 * A BARE unknown (`lastKnownKind === null`) still loses: we could not establish
 * anything, and an unknown must never displace a concrete local fact the
 * controller does know.
 *
 * A RETAINED-PHASE unknown does not lose, because it is not the absence of
 * knowledge — and rejecting it made the host-down window (Ticket 07 §5.2.7)
 * unrenderable on this surface. The projection's record arm ALWAYS returns
 * `kind: "unknown"` with `lastKnownKind` set: that is the deliberate shape for
 * "an attempt exists and the host is unreachable", chosen so the view holds no
 * lifecycle gate and earns no active poll. The blanket `kind !== "unknown"`
 * test therefore suppressed 100% of record-backed views, and the landing banner
 * showed nothing at all while a local update sat half-finished behind a host
 * that was not answering. The two modules downstream of this one were already
 * built for the case — `primarySentence` has a "Last seen: …" arm and
 * `showsProgressBar` an `unknown`-with-progress arm — and neither could ever be
 * reached from here.
 *
 * It still may not DISPLACE a concrete controller fact, which is the original
 * rule kept verbatim: a ready stage or activation debt is something the user
 * can act on now, and it outranks a phase we are only remembering.
 */
function operationSupersedesControllerStatus(
  view: FleetUpdateView,
  controllerHasConcreteFact: boolean,
): boolean {
  if (view.kind === "idle") return false;
  if (view.kind === "unknown") {
    return view.lastKnownKind !== null && !controllerHasConcreteFact;
  }
  return true;
}

/** Which of the three bodies is on screen. See where it is computed. */
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

/**
 * The one place the named branch becomes markup.
 *
 * A `switch` rather than the chained ternary this replaced, and separated from
 * the wrapper so that the element carrying `aria-live`, `aria-label` and the
 * destructive styling is built from `branch` in one place and rendered from
 * `branch` in another — with no room between them for a fourth reading of the
 * same two conditions.
 */
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

/**
 * A terminal attempt the landing banner has finished with.
 *
 * `complete` and `failed` only. `unavailable` is deliberately NOT dismissible —
 * its whole purpose is to stay visible until the record is repaired, and it
 * carries no attempt id to key a dismissal by in any case.
 */
function isLandingDismissed(
  view: FleetUpdateView,
  dismissedAttemptIds: ReadonlyArray<string>,
): boolean {
  if (view.kind !== "complete" && view.kind !== "failed") return false;
  const attemptId = view.attemptId;
  return attemptId !== null && dismissedAttemptIds.includes(attemptId);
}

/**
 * A completed update acknowledges itself and collapses.
 *
 * "Completion may auto-collapse after a short acknowledgement; Settings still
 * shows the running version" (experience doc). Without this a retained
 * `complete` record — which the host keeps for days — sat on the landing page
 * indefinitely announcing a success nobody had to act on.
 *
 * Keyed on the attempt id so the timer restarts for a genuinely new completion
 * and does nothing on a re-render. The dismissal it writes is the same one the
 * failure path uses, so "collapsed" and "dismissed" cannot drift into two
 * different notions of hidden.
 */
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

/**
 * The attempt-driven banner body: named phase, continuous progress, and — only
 * when live work is genuinely blocking the update — a prominent
 * **Force restart…**.
 *
 * WHAT IS DELIBERATELY ABSENT: any control that disables anything else. This
 * banner never gates Restart, Diagnostics, Activate or the overflow menu.
 * Update state is not a host-action mutex (plan §4), and the user is never
 * required to clear or dismiss this banner before recovering the host — which
 * is why there is no dismiss affordance on an active operation and no disabled
 * state applied to anything outside this element.
 */
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
          {/*
            Freshness, stated rather than implied. A qualified view is the last
            thing we knew, not what is true now, and the doc requires it be
            marked honestly rather than presented as live.

            `needsQualifiedMarker`, not `view.qualified`: when the sentence
            already begins "Last seen: …" a second marker here would say the
            same thing twice in one line.
          */}
          {props.copy.needsQualifiedMarker ? (
            <span
              className="ml-1 opacity-70"
              data-testid="host-update-banner-qualified"
            >
              (last known)
            </span>
          ) : null}
        </span>
        {/*
          Byte detail rides BESIDE the percentage rather than instead of it, and
          appears whenever the host measured it — including for an operation
          with no percentage at all, which is the case that previously showed
          nothing but an anonymous moving bar.
        */}
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
        {/*
          Diagnostics for the two states the contract points there: a failure
          (its "Retry; Diagnostics" pair) and an unreadable record, whose own
          copy already ends "see Diagnostics" and until now named a place with
          no way to get to it.
        */}
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
            {/*
              The ellipsis is load-bearing: it promises a confirmation step, and
              there is one. This click only ARMS the shared restart flow, which
              re-asks the host about live work and then requires the existing
              modal. It never restarts on the first click.
            */}
            Force restart…
          </Button>
        ) : null}
        {/*
          Dismiss exists ONLY for a failure, and only once there is an attempt
          id to remember it by. There is deliberately no dismiss on an active or
          parked operation — the doc forbids snoozing those away — and none on a
          completion, which collapses on its own.

          Dismissing hides this banner and nothing else: the selected-host
          Overview still shows the failed attempt, because "the failure remains
          discoverable in the selected-host Overview".
        */}
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
  /** Retry routing only — never banner visibility. See `onOperationRetry`. */
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
  // NOT part of `showDebt`, and deliberately separate from it.
  //
  // `ACTIVATION_DEBT_STATES` gates banner VISIBILITY across several surfaces,
  // and `unavailable` is the ordinary state during every healthy swap window —
  // widening that set would raise a debt banner every time a host restarts.
  // This flag is consumed by exactly one thing: which mutation a retry of an
  // ALREADY-FAILED attempt should dispatch. See `onOperationRetry`.
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
