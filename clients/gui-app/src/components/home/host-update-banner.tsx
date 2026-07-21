import { useMemo, useState } from "react";
import { ArrowDownToLine, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
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
  isHostUpdateBannerSnoozed,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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
  const management = runnerHost.hostManagement;
  if (management === null) {
    return null;
  }
  return (
    <HostUpdateBannerInner
      management={management}
      className={props.className}
    />
  );
}

interface HostUpdateBannerInnerProps {
  readonly management: IHostManagement;
  readonly className: string | undefined;
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

  const [busy, setBusy] = useState<BusyState | null>(null);
  const [terminalOutcome, setTerminalOutcome] =
    useState<TerminalOutcomeState | null>(null);

  const applyStagedMutation = useRunnerApplyStaged();
  const activateInstalledMutation = useRunnerActivateInstalled();

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
  const { showUpdate, showDebt, offeredVersion, installedVersion } =
    deriveOfferedVersion(status);
  const snoozed =
    terminalOutcome === null &&
    offeredVersion !== null &&
    isHostUpdateBannerSnoozed(snoozeUntilByVersion, offeredVersion, nowMs);

  const shouldShow = useMemo(
    () =>
      terminalOutcome !== null ||
      ((showUpdate || showDebt) && offeredVersion !== null && !snoozed),
    [terminalOutcome, showUpdate, showDebt, offeredVersion, snoozed],
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
  const bannerAriaLabel = deriveBannerAriaLabel(
    terminalOutcome,
    offeredVersion,
  );
  const bannerClassName = deriveBannerClassName(terminalOutcome, className);

  return (
    <>
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
        className={bannerClassName}
      >
        {terminalOutcome !== null ? (
          <TerminalOutcomeContent
            terminalOutcome={terminalOutcome}
            isPending={isPending}
            onRetry={() => {
              setTerminalOutcome(null);
              if (terminalOutcome.intent === "apply") {
                runApply(false);
              } else {
                runActivate(false);
              }
            }}
            onDismiss={() => {
              setTerminalOutcome(null);
            }}
          />
        ) : (
          <UpdateOrDebtContent
            showUpdate={showUpdate}
            offeredVersion={offeredVersion}
            installedVersion={installedVersion}
            isPending={isPending}
            percent={percent}
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
        )}
      </output>
    </>
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
  readonly offeredVersion: string | null;
  readonly installedVersion: string | null;
} {
  if (status === undefined) {
    return {
      showUpdate: false,
      showDebt: false,
      offeredVersion: null,
      installedVersion: null,
    };
  }
  const showUpdate = status.updateReady;
  const showDebt =
    !status.updateReady && ACTIVATION_DEBT_STATES.has(status.activation);
  let offeredVersion: string | null = null;
  if (showUpdate) {
    offeredVersion = status.stagedVersion;
  } else if (showDebt) {
    offeredVersion = status.installedVersion;
  }
  return {
    showUpdate,
    showDebt,
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
  terminalOutcome: TerminalOutcomeState | null,
  className: string | undefined,
): string {
  const stateClassName =
    terminalOutcome !== null
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
