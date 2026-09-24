import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  HostLifecycleMode,
  HostLifecycleView,
} from "@traycer-clients/shared/platform/runner-host";
import { LocalHostRestartFlow } from "@/components/host/local-host-restart-flow";
import { HostLifecycleNoneConfirmDialog } from "@/components/settings/host-lifecycle-none-confirm-dialog";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useRunnerHostLifecycleQuery } from "@/hooks/runner/use-runner-host-lifecycle-query";
import { useRunnerHostLifecycleSetMutation } from "@/hooks/runner/use-runner-host-lifecycle-set-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isPaid } from "@/lib/auth/traycer-subscription-content";
import {
  HOST_LIFECYCLE_FOOTNOTE_SET_COMMAND,
  HOST_LIFECYCLE_FOOTNOTE_START_COMMAND,
  HOST_LIFECYCLE_MODE_ORDER,
  HOST_LIFECYCLE_NONE_PLAN_REASON,
  HOST_LIFECYCLE_PENDING_RESTART_APP,
  HOST_LIFECYCLE_PENDING_RESTART_HOST,
  HOST_LIFECYCLE_READ_FAILED,
  HOST_LIFECYCLE_RESTART_HOST_LABEL,
  HOST_LIFECYCLE_SUPERSEDED_DESCRIPTION,
  HOST_LIFECYCLE_SUPERSEDED_TITLE,
  hostLifecycleCardSubtitle,
  hostLifecycleModeName,
  hostLifecycleOptionCopy,
  hostMachineNoun,
  type HostLifecycleOptionCopy,
} from "@/lib/host/host-lifecycle-copy";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Settings → General → "When you quit Traycer": what happens to this
 * machine's host when the app quits.
 *
 * A machine-local desktop preference read and written through desktop main
 * (`runnerHost.hostLifecycle`), never a host RPC, so it renders signed out,
 * before any host exists, and in a launch with no local host at all.
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

function HostLifecycleCard(): ReactNode {
  const machine = hostMachineNoun();
  const viewQuery = useRunnerHostLifecycleQuery();
  const setMode = useRunnerHostLifecycleSetMutation();
  const subscriptionStatus = useAuthStore((state) => state.subscriptionStatus);
  // Remote hosts are a paid feature, so on a plan without them "no host here"
  // leaves nothing usable. `null` is an unknown plan (signed out, not yet
  // read), which does not block.
  const noneBlockedByPlan =
    subscriptionStatus !== null && !isPaid(subscriptionStatus);
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
          if (result.kind !== "applied") setInlineError(result.message);
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
            disabledReason={
              option.mode === "none" && noneBlockedByPlan && desired !== "none"
                ? HOST_LIFECYCLE_NONE_PLAN_REASON
                : null
            }
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
      {view === undefined ? null : <HostLifecycleAppliedLine view={view} />}
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
 * the host to apply" (an older supervisor is running and enforces nothing), or
 * "Set to No local host · takes effect at next launch" (entering or leaving
 * `none` is restart-to-apply for the app itself).
 */
function HostLifecycleAppliedLine(props: {
  readonly view: HostLifecycleView;
}): ReactNode {
  const [restartRequested, setRestartRequested] = useState(false);
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
        disabled={restartRequested}
        onClick={() => {
          setRestartRequested(true);
        }}
        data-testid="host-lifecycle-restart-host"
      >
        {HOST_LIFECYCLE_RESTART_HOST_LABEL}
      </Button>
      <LocalHostRestartFlow
        requested={restartRequested}
        onClose={() => {
          setRestartRequested(false);
        }}
      />
    </div>
  );
}
