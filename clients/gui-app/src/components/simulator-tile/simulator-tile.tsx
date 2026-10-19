import { useCallback, useEffect, useRef } from "react";
import type {
  SimulatorSession,
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorHardwareButton } from "@traycer/protocol/host/simulator/stream-contracts";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useSimulatorActionMutation,
  useSimulatorCloseMutation,
  useSimulatorConfigQuery,
  useSimulatorConfigSetMutation,
  useSimulatorShutdownMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { nextOrientation } from "@/lib/simulator-view/simulator-input-encoding";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";
import {
  SimulatorFailedView,
  SimulatorHostUnreachableView,
  SimulatorInstallingView,
  SimulatorInventoryView,
  SimulatorLoadingView,
  SimulatorSetupView,
  SimulatorUnavailableView,
} from "./simulator-state-views";
import { SimulatorSurface } from "./simulator-surface";
import { SimulatorToolbar } from "./simulator-toolbar";
import { useOpenSimulatorTile } from "./use-open-simulator-tile";
import { useSimulatorScreenshot } from "./use-simulator-screenshot";
import { useSimulatorStream } from "./use-simulator-stream";

export interface SimulatorTileProps {
  readonly node: SimulatorTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
  readonly isActive: boolean;
}

/**
 * One simulator on the tab's host. Everything here reads the TAB host
 * (`useTabHostId` / `useTabHostClient`), never the active one: the tile is
 * bound to the machine the simulator runs on for life.
 *
 * What it shows follows the host's published state, in this order:
 *
 *   host unreachable ─▶ the ordinary host-disconnected notice
 *   host too old     ─▶ "needs an update"
 *   no platform      ─▶ why neither iOS nor Android can run there
 *   switch off       ─▶ the setup view with the switch
 *   installing       ─▶ progress
 *   failed           ─▶ the host's reason, retry
 *   no session       ─▶ the inventory, with Connect for this simulator
 *   session          ─▶ the live surface and its toolbar
 */
export function SimulatorTile(props: SimulatorTileProps) {
  const { node, viewTabId, tileId, epicId } = props;
  const hostId = useTabHostId();
  const reachability = useHostReachability(hostId);
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  const closeTile = useCloseCanvasTileWithNestedFocus(
    viewTabId,
    tileId,
    node.instanceId,
  );
  const hostLabel = reachability.hostLabel;

  if (reachability.status === "unreachable") {
    return <SimulatorHostUnreachableView hostLabel={hostLabel} />;
  }
  if (sessions.lifecycle === "unsupported") {
    return (
      <SimulatorUnavailableView
        hostLabel={hostLabel}
        platforms={[]}
        reason={sessions.errorMessage}
      />
    );
  }
  const state = sessions.state;
  if (state === null) {
    if (sessions.lifecycle === "failed" || sessions.lifecycle === "closed") {
      return (
        <SimulatorFailedView
          title={`Couldn't reach the simulators on ${hostLabel}`}
          reason={sessions.errorMessage}
          onRetry={sessions.retry}
        />
      );
    }
    return <SimulatorLoadingView hostLabel={hostLabel} />;
  }
  const noPlatform = state.platforms.every((platform) => !platform.available);
  if (state.packState.kind === "unsupported" || noPlatform) {
    return (
      <SimulatorUnavailableView
        hostLabel={hostLabel}
        platforms={state.platforms}
        reason={
          state.packState.kind === "unsupported" ? state.packState.reason : null
        }
      />
    );
  }
  if (state.packState.kind === "off") {
    return (
      <SimulatorSetupGate hostId={hostId} hostLabel={hostLabel} state={state} />
    );
  }
  if (state.packState.kind === "installing") {
    return (
      <SimulatorInstallingView
        hostLabel={hostLabel}
        progress={state.packState.progress}
      />
    );
  }
  if (state.packState.kind === "failed") {
    return (
      <SimulatorFailedView
        title={`Couldn't set up simulators on ${hostLabel}`}
        reason={state.packState.reason}
        onRetry={sessions.refresh}
      />
    );
  }
  if (state.hubState.kind === "failed") {
    return (
      <SimulatorFailedView
        title={`Simulators stopped on ${hostLabel}`}
        reason={state.hubState.lastError}
        onRetry={sessions.refresh}
      />
    );
  }
  const session =
    state.sessions.find((item) => item.simulatorId === node.simulatorId) ??
    null;
  if (session === null) {
    return (
      <SimulatorInventoryGate
        node={node}
        viewTabId={viewTabId}
        epicId={epicId}
        hostId={hostId}
        hostLabel={hostLabel}
        state={state}
      />
    );
  }
  return (
    <LiveSimulatorTile
      node={node}
      epicId={epicId}
      hostId={hostId}
      session={session}
      state={state}
      sessions={sessions}
      onCloseTile={closeTile}
    />
  );
}

/** The setup view, with the switch wired to this host's `config.simulator.set`. */
function SimulatorSetupGate(props: {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly state: SimulatorState;
}) {
  const hostClient = useTabHostClient();
  const config = useSimulatorConfigQuery(hostClient, props.hostId);
  const { mutation, supported } = useSimulatorConfigSetMutation(
    hostClient,
    props.hostId,
  );
  const agentAccess = config.data?.agentAccess ?? false;
  const { mutate, isPending } = mutation;
  const onEnabledChange = useCallback(
    (enabled: boolean) => {
      // Both switches travel on every write. Turning simulators off also
      // withdraws agent access, which the host refuses to keep without them.
      mutate({ enabled, agentAccess: enabled ? agentAccess : false });
    },
    [agentAccess, mutate],
  );
  return (
    <SimulatorSetupView
      hostLabel={props.hostLabel}
      platforms={props.state.platforms}
      enabled={config.data?.enabled ?? false}
      pending={isPending}
      onEnabledChange={supported ? onEnabledChange : null}
    />
  );
}

/**
 * The inventory while this tile's simulator has no session in the task. A
 * booted simulator is attached as soon as the tile is shown - attaching is
 * cheap and is what a tile restored after a reload wants - while a cold one
 * waits for the person's Connect, because a boot is slow and not something to
 * start by merely reopening a task.
 */
function SimulatorInventoryGate(props: {
  readonly node: SimulatorTileRef;
  readonly viewTabId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly state: SimulatorState;
}) {
  const { node, viewTabId, epicId, hostId, state } = props;
  const hostClient = useTabHostClient();
  const { openTile } = useEpicTileNavigation();
  const opener = useOpenSimulatorTile({ client: hostClient, hostId, epicId });
  const { open, supported, openingSimulatorId } = opener;

  const openSimulator = useCallback(
    (simulator: SimulatorSummary) => {
      open(simulator, (ref) => {
        // This tile's own simulator needs no new tile: the session the host
        // just recorded flips this body to the live view. Any other row is a
        // tile of its own, beside this one.
        if (ref.id === node.id) return;
        openTile(
          tileIntent(ref, { tabId: viewTabId }, "explicit", "direct_ui"),
        );
      });
    },
    [node.id, open, openTile, viewTabId],
  );

  const target =
    state.simulators.find(
      (simulator) => simulator.simulatorId === node.simulatorId,
    ) ?? null;
  const autoAttached = useRef(false);
  useEffect(() => {
    if (autoAttached.current || !supported) return;
    if (target === null || !target.booted) return;
    if (state.booting.includes(target.simulatorId)) return;
    autoAttached.current = true;
    openSimulator(target);
  }, [openSimulator, state.booting, supported, target]);

  return (
    <SimulatorInventoryView
      hostLabel={props.hostLabel}
      simulators={state.simulators}
      booting={state.booting}
      targetSimulatorId={node.simulatorId}
      targetName={target?.name ?? node.name}
      onOpen={supported ? openSimulator : null}
      openingSimulatorId={openingSimulatorId}
    />
  );
}

function LiveSimulatorTile(props: {
  readonly node: SimulatorTileRef;
  readonly epicId: string;
  readonly hostId: string;
  readonly session: SimulatorSession;
  readonly state: SimulatorState;
  readonly sessions: SimulatorSessionsState;
  readonly onCloseTile: () => void;
}) {
  const { node, epicId, hostId, session, state, onCloseTile } = props;
  const hostClient = useTabHostClient();
  const hostEntry = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const streamClient = useHostStreamClientFor(hostEntry, auth);
  const visible = useTileBodyVisible();
  const summary =
    state.simulators.find(
      (simulator) => simulator.simulatorId === node.simulatorId,
    ) ?? null;
  const simulatorName = summary?.name ?? node.name;
  const platform = session.platform;

  const stream = useSimulatorStream({
    client: streamClient,
    epicId,
    simulatorId: node.simulatorId,
    platform,
    visible,
  });
  const { controller, state: streamState } = stream;

  const close = useSimulatorCloseMutation(hostClient, hostId, node.simulatorId);
  const shutdown = useSimulatorShutdownMutation(
    hostClient,
    hostId,
    node.simulatorId,
  );
  const action = useSimulatorActionMutation(
    hostClient,
    hostId,
    node.simulatorId,
  );
  const screenshot = useSimulatorScreenshot({
    client: hostClient,
    hostId,
    epicId,
    simulatorId: node.simulatorId,
    simulatorName,
  });

  const closeMutate = close.mutation.mutate;
  const onClose = useCallback(() => {
    // The tile goes first: a close the host refuses still leaves the person
    // with the tile gone, which is what they asked for, and the session is
    // reported in the sidebar group until the host confirms.
    onCloseTile();
    if (close.supported) {
      closeMutate({ epicId, simulatorId: node.simulatorId, shutdown: false });
    }
  }, [close.supported, closeMutate, epicId, node.simulatorId, onCloseTile]);

  const shutdownMutate = shutdown.mutation.mutate;
  const onPowerOff = useCallback(() => {
    shutdownMutate(
      { epicId, simulatorId: node.simulatorId, platform },
      { onSuccess: onCloseTile },
    );
  }, [epicId, node.simulatorId, onCloseTile, platform, shutdownMutate]);

  const actionMutate = action.mutation.mutate;
  const orientation = streamState.config?.orientation ?? "portrait";
  const onRotate = useCallback(() => {
    if (platform === "ios") {
      controller?.rotate();
      return;
    }
    // Android rotates through the typed action: the hub has no orientation
    // message of its own, and the encoder restarts at the new size.
    actionMutate({
      epicId,
      simulatorId: node.simulatorId,
      action: { type: "setOrientation", value: nextOrientation(orientation) },
    });
  }, [
    actionMutate,
    controller,
    epicId,
    node.simulatorId,
    orientation,
    platform,
  ]);

  const inputReady = controller !== null && streamState.input.connected;
  // iOS turns on the stream (so it needs input); Android turns through the
  // typed action (so it needs the verb).
  const rotateReady = platform === "ios" ? inputReady : action.supported;
  const onPressButton = useCallback(
    (button: SimulatorHardwareButton) => {
      controller?.pressButton(button);
    },
    [controller],
  );
  const onReconnect = useCallback(() => {
    controller?.restart();
  }, [controller]);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-canvas text-foreground"
      data-testid={`simulator-tile-${node.instanceId}`}
    >
      <SimulatorToolbar
        platform={platform}
        simulatorName={simulatorName}
        version={summary?.version ?? ""}
        onPressButton={inputReady ? onPressButton : null}
        onRotate={rotateReady ? onRotate : null}
        rotatePending={platform === "android" && action.mutation.isPending}
        onScreenshot={screenshot.take}
        screenshotPending={screenshot.isPending}
        onPowerOff={shutdown.supported ? onPowerOff : null}
        powerOffPending={shutdown.mutation.isPending}
        onClose={onClose}
      />
      <SimulatorSurface
        platform={platform}
        simulatorName={simulatorName}
        controller={controller}
        state={streamState}
        sink={stream.sink}
        onReconnect={onReconnect}
      />
    </div>
  );
}
