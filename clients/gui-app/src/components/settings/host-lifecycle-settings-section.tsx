import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  HostEnsureFailure,
  HostLifecycleMode,
  HostLifecycleView,
} from "@traycer-clients/shared/platform/runner-host";
import {
  isServiceTaskNotOwnedMessage,
  SERVICE_TASK_NOT_OWNED_CODE,
  SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE,
} from "@traycer-clients/shared/platform/host-service-notices";
import { LocalHostRestartFlow } from "@/components/host/local-host-restart-flow";
import { HostLifecycleNoneConfirmDialog } from "@/components/settings/host-lifecycle-none-confirm-dialog";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRunnerHostLifecycleQuery } from "@/hooks/runner/use-runner-host-lifecycle-query";
import { useRunnerHostLifecycleSetMutation } from "@/hooks/runner/use-runner-host-lifecycle-set-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  HOST_FOREGROUND_RESTART_TO_APPLY_REASON,
  HOST_LIFECYCLE_FOOTNOTE_SET_COMMAND,
  HOST_LIFECYCLE_FOOTNOTE_START_COMMAND,
  HOST_LIFECYCLE_MODE_ORDER,
  HOST_LIFECYCLE_NONE_SIGNED_OUT_REASON,
  HOST_LIFECYCLE_PENDING_RESTART_APP,
  HOST_LIFECYCLE_PENDING_RESTART_HOST,
  HOST_LIFECYCLE_READ_FAILED,
  HOST_LIFECYCLE_RESTART_HOST_LABEL,
  HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
  HOST_LIFECYCLE_SUPERSEDED_TITLE,
  HOST_LIFECYCLE_TASK_NOT_OWNED_REASON,
  hostLifecycleCardSubtitle,
  hostLifecycleModeName,
  hostLifecycleOptionCopy,
  hostLifecycleSetRefusalCopy,
  hostMachineNoun,
  type HostLifecycleOptionCopy,
} from "@/lib/host/host-lifecycle-copy";
import { isForegroundHostRun } from "@/lib/host/host-foreground-run";
import { useShellLocalPlaneAdmission } from "@/hooks/auth/use-shell-local-plane-admission";

/**
 * Settings → General → "When you quit Traycer": what happens to this
 * machine's host when the app quits.
 *
 * A machine-local desktop preference read and written through desktop main
 * (`runnerHost.hostLifecycle`), never a host RPC, so it needs no host: it
 * works before any host exists and in a launch with no local host at all.
 * Signed in it sits in Settings → General. Signed out the settings shell is
 * not reachable, so this card renders on its own at `/when-you-quit`, which
 * is where the desktop's "Settings…" (menu, tray, jump list) goes then.
 */
export function HostLifecycleSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (!GENERAL.definitions.hostLifecycle.availableWhen(availability)) {
    return null;
  }
  return (
    <SettingsGroup
      group={GENERAL.definitions.hostLifecycle}
      showTitle
      tone="default"
      dataTestId="settings-host-lifecycle"
      fill={false}
    >
      <HostLifecycleCard />
    </SettingsGroup>
  );
}

/**
 * The card's notice when the last ensure was refused because the host's task
 * is not this account's, or `null`. It is main's own copy for the reason -
 * another Windows user's task, or one whose owner could not be confirmed - and
 * a message this build does not recognise reads as unconfirmed, so the card
 * never calls the task another user's unless main did.
 */
function taskNotOwnedNotice(failure: HostEnsureFailure | null): string | null {
  if (failure === null || failure.code !== SERVICE_TASK_NOT_OWNED_CODE) {
    return null;
  }
  return isServiceTaskNotOwnedMessage(failure.message)
    ? failure.message
    : SERVICE_TASK_OWNER_UNCONFIRMED_MESSAGE;
}

function HostLifecycleCard(): ReactNode {
  const machine = hostMachineNoun();
  const viewQuery = useRunnerHostLifecycleQuery();
  const setMode = useRunnerHostLifecycleSetMutation();
  // A remote host is reached through the signed-in account, so signed out
  // "no host here" leaves nothing usable and `none` is held. Remote hosts are
  // available on every plan, so nothing about the subscription enters this. A
  // `none` already chosen stays selectable either way (`desired` below).
  const noneBlockedSignedOut = !useShellLocalPlaneAdmission().admitted;
  // The host's Scheduled Task is not this account's (the last ensure was
  // refused `E_SERVICE_TASK_NOT_OWNED`): this account has no background host
  // on this PC. The card says why (`taskNotOwnedNotice`), holds the modes that
  // would run one here - the service refresh a switch between them makes is
  // refused - and keeps `none`, the one choice that still means something.
  const taskNotOwnedMessage = taskNotOwnedNotice(
    useRunnerHostControllerStatusQuery().data?.lastEnsureFailure ?? null,
  );
  const taskNotOwned = taskNotOwnedMessage !== null;
  const [confirmNone, setConfirmNone] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const view = viewQuery.data;
  const desired = view === undefined ? null : view.desired.mode;
  const pendingMode = setMode.isPending ? setMode.variables.request.mode : null;

  const choose = (mode: HostLifecycleMode): void => {
    if (view === undefined || mode === view.desired.mode) return;
    setInlineError(null);
    // Entering `none` while this launch runs a host stops that host, so it is
    // confirmed with the list of what it would end. A launch that already runs
    // none has nothing to stop.
    if (mode === "none" && view.applied.localHostCapability === "managed") {
      setConfirmNone(true);
      return;
    }
    setMode.mutate(
      { request: { mode, stop: null }, source: "settings" },
      {
        onSuccess: (result) => {
          if (result.kind === "superseded") {
            toast.info(HOST_LIFECYCLE_SUPERSEDED_TITLE, {
              description: HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
            });
            return;
          }
          if (result.kind !== "applied") {
            setInlineError(hostLifecycleSetRefusalCopy(result.reason));
          }
        },
      },
    );
  };

  return (
    <div
      className="flex flex-col gap-3 px-3.5 py-3"
      data-testid="host-lifecycle-card"
    >
      <p className="text-ui-sm text-muted-foreground">
        {hostLifecycleCardSubtitle(machine)}
      </p>
      {taskNotOwned ? (
        <p
          className="text-ui-sm text-warning-foreground"
          data-testid="host-lifecycle-task-not-owned"
        >
          {taskNotOwnedMessage}
        </p>
      ) : null}
      {viewQuery.isError && view === undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <p
            className="min-w-0 text-ui-sm text-destructive"
            data-testid="host-lifecycle-read-error"
          >
            {HOST_LIFECYCLE_READ_FAILED}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={viewQuery.isFetching}
            onClick={() => {
              void viewQuery.refetch();
            }}
          >
            {viewQuery.isFetching ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Try again
          </Button>
        </div>
      ) : null}
      <RadioGroup
        value={pendingMode ?? desired ?? ""}
        onValueChange={(value) => {
          const mode = HOST_LIFECYCLE_MODE_ORDER.find(
            (candidate) => candidate === value,
          );
          if (mode !== undefined) choose(mode);
        }}
        disabled={view === undefined || setMode.isPending}
        aria-label={GENERAL.definitions.hostLifecycle.label}
        data-testid="host-lifecycle-options"
      >
        {hostLifecycleOptionCopy(machine).map((option) => (
          <HostLifecycleOption
            key={option.mode}
            option={option}
            pending={pendingMode === option.mode}
            disabledReason={hostLifecycleOptionDisabledReason(
              option.mode,
              desired,
              noneBlockedSignedOut,
              taskNotOwned,
            )}
          />
        ))}
      </RadioGroup>
      {inlineError === null ? null : (
        <p
          className="text-ui-sm text-destructive"
          data-testid="host-lifecycle-error"
        >
          {inlineError}
        </p>
      )}
      {view === undefined ? null : (
        <HostLifecycleAppliedLine view={view} taskNotOwned={taskNotOwned} />
      )}
      <p className="border-t border-border/60 pt-3 text-ui-xs text-muted-foreground">
        Hosts you start from the terminal with{" "}
        <code className="font-mono">
          {HOST_LIFECYCLE_FOOTNOTE_START_COMMAND}
        </code>{" "}
        are not affected. Change from the CLI with{" "}
        <code className="font-mono">{HOST_LIFECYCLE_FOOTNOTE_SET_COMMAND}</code>
        .
      </p>
      <HostLifecycleNoneConfirmDialog
        open={confirmNone}
        onClose={() => {
          setConfirmNone(false);
        }}
      />
    </div>
  );
}

/**
 * Why a mode cannot be chosen, or `null`. A mode already chosen stays
 * selectable (it is what the card shows as set).
 */
function hostLifecycleOptionDisabledReason(
  mode: HostLifecycleMode,
  desired: HostLifecycleMode | null,
  noneBlockedSignedOut: boolean,
  taskNotOwned: boolean,
): string | null {
  if (mode === desired) return null;
  if (mode === "none") {
    return noneBlockedSignedOut ? HOST_LIFECYCLE_NONE_SIGNED_OUT_REASON : null;
  }
  return taskNotOwned ? HOST_LIFECYCLE_TASK_NOT_OWNED_REASON : null;
}

function HostLifecycleOption(props: {
  readonly option: HostLifecycleOptionCopy;
  readonly pending: boolean;
  readonly disabledReason: string | null;
}): ReactNode {
  const id = useId();
  const descriptionId = useId();
  return (
    <div
      className="flex items-start gap-3 py-1"
      data-testid={`host-lifecycle-option-${props.option.mode}`}
    >
      <RadioGroupItem
        value={props.option.mode}
        id={id}
        aria-describedby={descriptionId}
        disabled={props.disabledReason !== null}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label htmlFor={id}>
          {props.option.label}
          {props.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Label>
        <p id={descriptionId} className="text-ui-sm text-muted-foreground">
          {props.option.description}
          {props.disabledReason === null ? null : (
            <>
              {" "}
              <span data-testid="host-lifecycle-none-plan-reason">
                {props.disabledReason}
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Desired vs applied, shown only while they differ: "Set to Linked · restart
 * the host to apply" (an older supervisor is running and enforces nothing, or
 * a host started in a terminal is), or "Set to No local host · takes effect at
 * next launch" (entering or leaving `none` is restart-to-apply for the app
 * itself).
 *
 * A host started in a terminal is the person's to restart, never this app's,
 * so its Restart host is disabled with the reason instead of offered.
 */
function HostLifecycleAppliedLine(props: {
  readonly view: HostLifecycleView;
  /** No service host of this account's to restart: see `taskNotOwned`. */
  readonly taskNotOwned: boolean;
}): ReactNode {
  const [restartRequested, setRestartRequested] = useState(false);
  const reasonId = useId();
  const { view } = props;
  if (view.pending === "none") return null;
  const name = hostLifecycleModeName(view.desired.mode);
  if (view.pending === "restart-app") {
    return (
      <p
        className="text-ui-sm text-info-foreground"
        data-testid="host-lifecycle-applied-line"
      >
        Set to {name} · {HOST_LIFECYCLE_PENDING_RESTART_APP}
      </p>
    );
  }
  const foreground = isForegroundHostRun(view);
  // Another Windows user's task: a restart would be refused before it touched
  // anything, so none is offered. The card's notice already says why.
  if (props.taskNotOwned) {
    return (
      <p
        className="text-ui-sm text-info-foreground"
        data-testid="host-lifecycle-applied-line"
      >
        Set to {name} · {HOST_LIFECYCLE_PENDING_RESTART_HOST}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p
        className="min-w-0 text-ui-sm text-info-foreground"
        data-testid="host-lifecycle-applied-line"
      >
        Set to {name} · {HOST_LIFECYCLE_PENDING_RESTART_HOST}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restartRequested || foreground}
        aria-describedby={foreground ? reasonId : undefined}
        onClick={() => {
          setRestartRequested(true);
        }}
        data-testid="host-lifecycle-restart-host"
      >
        {HOST_LIFECYCLE_RESTART_HOST_LABEL}
      </Button>
      {foreground ? (
        <p
          id={reasonId}
          className="w-full text-ui-xs text-muted-foreground"
          data-testid="host-lifecycle-restart-host-reason"
        >
          {HOST_FOREGROUND_RESTART_TO_APPLY_REASON}
        </p>
      ) : null}
      {/* `service`: this line means the running supervisor predates lifecycle
          enforcement, and the cooperative `host.restart` would only have that
          old supervisor respawn its child. */}
      <LocalHostRestartFlow
        requested={restartRequested}
        firstLeg="service"
        onClose={() => {
          setRestartRequested(false);
        }}
      />
    </div>
  );
}
