/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Mobile simulators).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  SIMULATOR_IDLE_MINUTES_MAX,
  SIMULATOR_IDLE_MINUTES_MIN,
  type SimulatorHostInstance,
} from "@traycer/protocol/host/simulator/schemas";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { useSimulatorTaskTitles } from "@/components/settings/panels/use-simulator-task-titles";
import { SettingsRow } from "@/components/settings/settings-row";
import { SimulatorAgentBadge } from "@/components/simulator-tile/simulator-agent-badge";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import {
  type GatedSimulatorMutation,
  useSimulatorInstancesQuery,
  useSimulatorPowerOffMutation,
  useSimulatorSetKeepRunningMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import type { HostRpcRegistry } from "@/lib/host";
import {
  simulatorIdleCountdownLabel,
  simulatorVersionLabel,
} from "@/lib/simulator-view/simulator-labels";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";

/**
 * The Mobile simulators trigger's badge: how many instances run on this host
 * now, from the same polled `simulator.instances` read the tab's Running now
 * row shows. Nothing while none run or the host cannot say.
 */
export function HostOverviewSimulatorsCount(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}): ReactNode {
  const instances = useSimulatorInstancesQuery(
    props.client,
    props.hostId,
    true,
  );
  const count = instances.data?.instances.length ?? 0;
  if (count === 0) return null;
  return (
    <span
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-micro font-semibold leading-none text-foreground tabular-nums"
      data-testid="host-overview-simulators-count"
      data-count={count}
    >
      <span aria-hidden>{count}</span>
      <span className="sr-only">{`, ${count} running`}</span>
    </span>
  );
}

/** Every instance booted on this host, with Power off and Keep running. */
export function SimulatorRunningNowRow(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}): ReactNode {
  const { client, hostId } = props;
  const instances = useSimulatorInstancesQuery(client, hostId, true);
  const nowMs = useNowMs(30_000);
  const list = useMemo(() => instances.data?.instances ?? [], [instances.data]);
  const epicIds = useMemo(
    () => [
      ...new Set(
        list.flatMap((instance) => instance.tasks.map((task) => task.epicId)),
      ),
    ],
    [list],
  );
  const titles = useSimulatorTaskTitles(epicIds);
  const navigate = useNavigate();
  const openTask = useCallback(
    (epicId: string): void => {
      navigateToTabIntent(
        navigate,
        openOrFocusEpicIntent({ epicId, focus: undefined }),
        undefined,
      );
    },
    [navigate],
  );
  let status: string | undefined;
  if (instances.isError) status = "Couldn't ask this host.";
  else if (instances.data !== undefined && list.length === 0)
    status = "No simulators are running on this host.";
  return (
    <SettingsRow
      row={HOST_OVERVIEW.definitions.simulatorRunningNow}
      status={status}
      control={null}
      details={
        list.length === 0 ? null : (
          <ul
            className="w-full divide-y divide-border/40"
            data-testid="host-overview-simulators-running"
          >
            {list.map((instance) => (
              <SimulatorInstanceItem
                key={instance.instanceKey}
                client={client}
                hostId={hostId}
                instance={instance}
                nowMs={nowMs}
                titles={titles}
                onOpenTask={openTask}
              />
            ))}
          </ul>
        )
      }
    />
  );
}

/**
 * The tasks holding an instance: a link to each one the viewer can see, by
 * its title where the app has one and its short id otherwise, then how many
 * other tasks hold it.
 */
function SimulatorInstanceTasks(props: {
  readonly instance: SimulatorHostInstance;
  readonly titles: ReadonlyMap<string, string>;
  readonly onOpenTask: (epicId: string) => void;
}): ReactNode {
  const { instance } = props;
  if (instance.tasks.length === 0 && instance.otherTaskCount === 0)
    return <span>Open in no task</span>;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5"
      data-testid={`host-overview-simulator-tasks-${instance.instanceKey}`}
    >
      <span>Open in</span>
      {instance.tasks.map((task) => {
        const label = props.titles.get(task.epicId) ?? task.epicId.slice(0, 8);
        return (
          <Button
            key={task.epicId}
            type="button"
            variant="link"
            size="inline-xs"
            aria-label={`Open task ${label}`}
            onClick={() => props.onOpenTask(task.epicId)}
          >
            <span className="truncate">{label}</span>
          </Button>
        );
      })}
      {instance.otherTaskCount > 0 ? (
        <span>{`+${instance.otherTaskCount} other`}</span>
      ) : null}
    </span>
  );
}

function SimulatorInstanceItem(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly instance: SimulatorHostInstance;
  readonly nowMs: number;
  readonly titles: ReadonlyMap<string, string>;
  readonly onOpenTask: (epicId: string) => void;
}): ReactNode {
  const { client, hostId, instance } = props;
  const powerOff = useSimulatorPowerOffMutation(
    client,
    hostId,
    instance.instanceKey,
  );
  const keepRunning = useSimulatorSetKeepRunningMutation(
    client,
    hostId,
    instance.instanceKey,
  );
  const countdown = simulatorIdleCountdownLabel(
    instance.idleUntil,
    props.nowMs,
  );
  const version = simulatorVersionLabel(instance);
  const detail =
    instance.cloneOfName === null
      ? version
      : `Copy of ${instance.cloneOfName} · ${version}`;
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
      data-testid={`host-overview-simulator-${instance.instanceKey}`}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground">
          <span className="truncate">{instance.name}</span>
          {instance.drivenByAgent ? <SimulatorAgentBadge /> : null}
        </div>
        <div className="text-ui-xs text-muted-foreground">
          {[detail, countdown].filter((part) => part !== null).join(" · ")}
        </div>
        <div className="text-ui-xs text-muted-foreground">
          <SimulatorInstanceTasks
            instance={instance}
            titles={props.titles}
            onOpenTask={props.onOpenTask}
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {instance.bootedByTraycer && keepRunning.supported ? (
          <KeepRunningButton instance={instance} mutation={keepRunning} />
        ) : null}
        {powerOff.supported ? (
          <PowerOffButton instance={instance} mutation={powerOff} />
        ) : null}
      </div>
    </li>
  );
}

function KeepRunningButton(props: {
  readonly instance: SimulatorHostInstance;
  readonly mutation: GatedSimulatorMutation<"simulator.setKeepRunning">;
}): ReactNode {
  const { instance } = props;
  const { mutate, isPending } = props.mutation.mutation;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={isPending}
      aria-pressed={instance.keepRunning}
      data-testid={`host-overview-simulator-keep-running-${instance.instanceKey}`}
      onClick={() =>
        mutate({
          instanceKey: instance.instanceKey,
          keepRunning: !instance.keepRunning,
        })
      }
    >
      {isPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : null}
      {instance.keepRunning ? "Kept running" : "Keep running"}
    </Button>
  );
}

/**
 * Power off asks first only when the host says a mid-turn agent holds the
 * instance: the first send carries `confirm: false`, and a `confirm-required`
 * answer opens the dialog whose confirm sends `confirm: true`.
 */
function PowerOffButton(props: {
  readonly instance: SimulatorHostInstance;
  readonly mutation: GatedSimulatorMutation<"simulator.powerOff">;
}): ReactNode {
  const { instance } = props;
  const { mutateAsync, mutate, isPending } = props.mutation.mutation;
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={isPending}
        data-testid={`host-overview-simulator-power-off-${instance.instanceKey}`}
        onClick={() => {
          void mutateAsync({
            instanceKey: instance.instanceKey,
            confirm: false,
          }).then(
            (answer) => {
              if (answer.kind === "confirm-required") setConfirming(true);
            },
            () => undefined,
          );
        }}
      >
        {isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
        Power off
      </Button>
      <ConfirmDestructiveDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Power off ${instance.name}?`}
        description="An agent is using it right now. Powering it off ends every task's session on it and stops the agent's work there."
        cascadeSummary={null}
        actionLabel="Power off"
        isPending={isPending}
        blockedReason={null}
        onConfirm={() => {
          setConfirming(false);
          mutate({ instanceKey: instance.instanceKey, confirm: true });
        }}
      />
    </>
  );
}

/**
 * The idle window, written as `{ enabled: null, idleMinutes }` so the write
 * never turns simulators on or off. Only drawn for a `@1.1` host: a `@1.0`
 * host has no idle rule and refuses the null switch.
 */
export function SimulatorIdleWindowRow(props: {
  readonly idleMinutes: number;
  readonly writing: boolean;
  readonly write: (idleMinutes: number) => void;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(props.idleMinutes);
  const commit = (): void => {
    if (draft === null) return;
    const minutes = Number(draft);
    setDraft(null);
    if (
      !Number.isInteger(minutes) ||
      minutes < SIMULATOR_IDLE_MINUTES_MIN ||
      minutes > SIMULATOR_IDLE_MINUTES_MAX
    )
      return;
    props.write(minutes);
  };
  return (
    <SettingsRow
      row={HOST_OVERVIEW.definitions.simulatorIdleWindow}
      control={
        <Input
          type="number"
          inputMode="numeric"
          size="sm"
          className="w-full max-w-24"
          min={SIMULATOR_IDLE_MINUTES_MIN}
          max={SIMULATOR_IDLE_MINUTES_MAX}
          step={1}
          disabled={props.writing}
          aria-label="Minutes before an idle simulator powers off"
          data-testid="settings-simulators-idle-minutes"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      }
    />
  );
}
