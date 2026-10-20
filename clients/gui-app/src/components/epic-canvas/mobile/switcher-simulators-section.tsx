import { useCallback, useMemo, type ReactNode } from "react";
import { Smartphone, X } from "lucide-react";
import type {
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SwitcherListRow } from "@/components/epic-canvas/mobile/switcher-list-row";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useOpenSimulatorTile } from "@/components/simulator-tile/use-open-simulator-tile";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useSimulatorCloseMutation,
  useSimulatorConfigQuery,
  useSimulatorConfigSetMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import {
  orderSimulators,
  simulatorHasSession,
} from "@/lib/simulator-view/simulator-sessions-coordinator";
import { useSimulatorInventoryRefreshOnMount } from "@/lib/simulator-view/use-simulator-inventory-refresh";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";
import { useIsActiveTile } from "@/stores/epics/canvas/store";
import { simulatorTileId } from "@/stores/epics/canvas/tile-schema/simulator-tile";

/**
 * The Browsers category's Simulators section: the desktop panel's Simulators
 * group (`epic-simulator-sidebar.tsx`) in the switcher's touch chrome - the
 * same host (the browsers surface pin), the same order, the same open path,
 * on 44px rows.
 *
 * A tap places the tile and closes the sheet at once; the tile connects (and
 * boots, when asked) on its own, so a slow boot never holds the sheet. A row
 * the task holds a session on is marked "Open" and attaches to it; the row's
 * action ends that session, as on desktop.
 */
export function SwitcherSimulatorsSection(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
  readonly onClose: () => void;
}) {
  const { epicId, tabId, hostId, onClose } = props;
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  // As on desktop: a fresh host lists nothing until something runs `simulator.list`.
  useSimulatorInventoryRefreshOnMount({ hostId, sessions });
  const { open, supported } = useOpenSimulatorTile({ hostId });
  const activate = useSwitcherActivate(tabId, onClose);
  const openSimulator = useCallback(
    (simulator: SimulatorSummary) => {
      open(simulator, (ref) => activate(() => ref));
    },
    [activate, open],
  );

  const state = sessions.state;
  const simulators = useMemo(
    () => (state === null ? [] : orderSimulators(state.simulators)),
    [state],
  );

  // As on desktop: a host that cannot run simulators gets no section at all.
  if (hostId === null || sessions.lifecycle === "unsupported") return null;
  if (state === null) return null;
  if (state.platforms.every((platform) => !platform.available)) return null;

  return (
    <section
      aria-label="Simulators"
      className="mt-1.5"
      data-testid="switcher-simulators-section"
    >
      <h3 className="sticky top-0 z-10 bg-popover px-3 pt-2 pb-1 text-overline text-muted-foreground">
        Simulators
      </h3>
      <SwitcherSimulatorsBody
        epicId={epicId}
        hostId={hostId}
        tabId={tabId}
        state={state}
        simulators={simulators}
        onOpen={supported ? openSimulator : null}
      />
    </section>
  );
}

function SwitcherSimulatorsBody(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly tabId: string;
  readonly state: SimulatorState;
  readonly simulators: readonly SimulatorSummary[];
  readonly onOpen: ((simulator: SimulatorSummary) => void) | null;
}) {
  const { state } = props;
  if (state.packState.kind === "off") {
    return <SwitcherSimulatorsOffNote hostId={props.hostId} />;
  }
  if (state.packState.kind === "installing") {
    return (
      <SwitcherSimulatorsNote
        leading={
          <AgentSpinningDots
            className="shrink-0"
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        }
        text="Setting up simulators on this host…"
        trailing={null}
      />
    );
  }
  if (state.packState.kind === "failed") {
    return (
      <SwitcherSimulatorsNote
        leading={null}
        text="Simulators couldn't be set up on this host."
        trailing={null}
      />
    );
  }
  if (props.simulators.length === 0) {
    return (
      <SwitcherSimulatorsNote
        leading={null}
        text={
          state.hubState.kind === "failed"
            ? "Simulators stopped on this host."
            : "No simulators on this host."
        }
        trailing={null}
      />
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {props.simulators.map((simulator) => (
        <SwitcherSimulatorRow
          key={simulator.simulatorId}
          epicId={props.epicId}
          hostId={props.hostId}
          tabId={props.tabId}
          simulator={simulator}
          busy={state.booting.includes(simulator.simulatorId)}
          open={simulatorHasSession(state, simulator.simulatorId)}
          onOpen={props.onOpen}
        />
      ))}
    </div>
  );
}

function SwitcherSimulatorRow(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly tabId: string;
  readonly simulator: SimulatorSummary;
  readonly busy: boolean;
  /** The task holds a session on this simulator. */
  readonly open: boolean;
  readonly onOpen: ((simulator: SimulatorSummary) => void) | null;
}) {
  const { epicId, hostId, simulator, busy, open, onOpen } = props;
  const isActive = useIsActiveTile(
    props.tabId,
    simulatorTileId({ hostId, simulatorId: simulator.simulatorId }),
    hostId,
  );
  // The row has no disabled state, so a tap while the simulator boots (or on
  // a host without `simulator.open`) is simply not acted on.
  const onSelect = useCallback(() => {
    if (busy || onOpen === null) return;
    onOpen(simulator);
  }, [busy, onOpen, simulator]);
  const platformLabel = simulator.platform === "ios" ? "iOS" : "Android";
  return (
    <SwitcherListRow
      icon={<Smartphone className="size-4" aria-hidden />}
      label={simulator.name}
      secondaryLabel={`${platformLabel} ${simulator.version}`}
      badge={
        <SwitcherSimulatorBadge
          busy={busy}
          booted={simulator.booted}
          open={open}
        />
      }
      active={isActive}
      onSelect={onSelect}
      actions={
        open ? (
          <SwitcherSimulatorCloseAction
            epicId={epicId}
            hostId={hostId}
            simulator={simulator}
          />
        ) : null
      }
      selectTestId={`switcher-simulator-row-${simulator.simulatorId}`}
    />
  );
}

/** Ends the task's session on this simulator; the desktop row's X. */
function SwitcherSimulatorCloseAction(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly simulator: SimulatorSummary;
}) {
  const { epicId, hostId, simulator } = props;
  const hostClient = useHostClientForHostId(hostId);
  const close = useSimulatorCloseMutation(
    hostClient,
    hostId,
    simulator.simulatorId,
  );
  const { mutate, isPending } = close.mutation;
  if (!close.supported) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={isPending}
      aria-label={`Close ${simulator.name} in this task`}
      data-testid={`switcher-simulator-close-${simulator.simulatorId}`}
      className="shrink-0"
      onClick={() =>
        mutate({ epicId, simulatorId: simulator.simulatorId, shutdown: false })
      }
    >
      {isPending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      ) : (
        <X className="size-4" aria-hidden />
      )}
    </Button>
  );
}

function SwitcherSimulatorBadge(props: {
  readonly busy: boolean;
  readonly booted: boolean;
  readonly open: boolean;
}) {
  if (props.busy) {
    return (
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (props.open) {
    return (
      <Badge variant="info" size="xs" className="shrink-0">
        Open
      </Badge>
    );
  }
  if (!props.booted) return null;
  return (
    <Badge variant="success" size="xs" className="shrink-0">
      Running
    </Badge>
  );
}

function SwitcherSimulatorsNote(props: {
  readonly leading: ReactNode;
  readonly text: string;
  readonly trailing: ReactNode;
}) {
  return (
    <div
      className="flex min-h-11 items-center gap-2 px-3 text-ui-xs text-muted-foreground"
      data-testid="switcher-simulators-note"
    >
      {props.leading}
      <span className="min-w-0 flex-1">{props.text}</span>
      {props.trailing}
    </div>
  );
}

/** The desktop group's "Turn on", for a host with simulators switched off. */
function SwitcherSimulatorsOffNote(props: { readonly hostId: string }) {
  const hostClient = useHostClientForHostId(props.hostId);
  const config = useSimulatorConfigQuery(hostClient, props.hostId);
  const { mutation, supported } = useSimulatorConfigSetMutation(
    hostClient,
    props.hostId,
  );
  const { mutate, isPending } = mutation;
  const agentAccess = config.data?.agentAccess ?? false;
  return (
    <SwitcherSimulatorsNote
      leading={null}
      text="Simulators are off on this host."
      trailing={
        supported ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            data-testid="switcher-simulators-turn-on"
            onClick={() => mutate({ enabled: true, agentAccess })}
          >
            {isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
            Turn on
          </Button>
        ) : null
      }
    />
  );
}
