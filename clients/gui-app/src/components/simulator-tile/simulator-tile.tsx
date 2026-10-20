import { useCallback, useEffect, useRef, useState } from "react";
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
  useSimulatorOpenMutation,
  useSimulatorShutdownMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  takeSimulatorConnectRequest,
  usePendingSimulatorConnectRequest,
} from "@/lib/simulator-view/simulator-connect-requests";
import { nextOrientation } from "@/lib/simulator-view/simulator-input-encoding";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";
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
import { SimulatorSettingsDrawer } from "./simulator-settings-drawer";
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
 *
 * The task's session on this simulator may be one this tile opened, or one
 * it found - an agent's `simulator_open`, another window's tile, a session
 * that outlived a reload. The tile remembers which: closing it ends only a
 * session it opened itself, and a tile that has been live once does not
 * reconnect on its own when the session goes away under it (the agent closed
 * it, or the person did from the sidebar), where a freshly restored tile does.
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
  const state = sessions.state;
  const session = findSessionFor(state, node.simulatorId);
  const { openedHere, onOpened, wasLive } = useSessionMemory(session);
  const connectRequest = usePendingSimulatorConnectRequest(node.id);
  useEffect(() => {
    // A row click on a simulator this tile already shows live: nothing to
    // connect, and the request must not fire later when the session ends.
    if (connectRequest === null || session === null) return;
    takeSimulatorConnectRequest(node.id, connectRequest);
  }, [connectRequest, node.id, session]);

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
  if (session === null) {
    return (
      <SimulatorInventoryGate
        node={node}
        viewTabId={viewTabId}
        epicId={epicId}
        hostId={hostId}
        hostLabel={hostLabel}
        state={state}
        autoAttach={!wasLive}
        connectRequest={connectRequest}
        onOpened={onOpened}
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
      closesSession={openedHere}
      onCloseTile={closeTile}
    />
  );
}

function findSessionFor(
  state: SimulatorState | null,
  simulatorId: string,
): SimulatorSession | null {
  if (state === null) return null;
  return (
    state.sessions.find((item) => item.simulatorId === simulatorId) ?? null
  );
}

/**
 * What the tile remembers about its session across the inventory and live
 * views: whether THIS tile sent the `simulator.open` it came from, and
 * whether the tile has been live at all. `wasLive` is set the first time a
 * session is seen, during render (React's "storing information from previous
 * renders"), so the inventory that follows a closed session knows not to
 * reconnect.
 */
function useSessionMemory(session: SimulatorSession | null): {
  readonly openedHere: boolean;
  readonly onOpened: () => void;
  readonly wasLive: boolean;
} {
  const [openedHere, setOpenedHere] = useState(false);
  const onOpened = useCallback(() => {
    setOpenedHere(true);
  }, []);
  const [wasLive, setWasLive] = useState(session !== null);
  if (session !== null && !wasLive) setWasLive(true);
  return { openedHere, onOpened, wasLive };
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
 * The inventory while this tile's simulator has no session in the task. This
 * is the one place `simulator.open` is sent from, on three cues: an explicit
 * open's one-shot `connectRequest` (the row click already said "boot this",
 * cold or not); a booted target as soon as the tile is shown (`autoAttach`),
 * which is what a tile restored after a reload wants; and the person's own
 * "Boot and connect", the only way a restored cold tile boots, because a
 * boot is slow and not something to start by merely reopening a task. The
 * session the host records reaches this tile on the sessions stream and
 * flips it to the live view, so a boot that outlasts the RPC frame timeout
 * still ends in a streaming tile. Every other row places a tile of its own
 * beside this one.
 */
function SimulatorInventoryGate(props: {
  readonly node: SimulatorTileRef;
  readonly viewTabId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly state: SimulatorState;
  /** Connect a booted target without a click; false once this tile has been live. */
  readonly autoAttach: boolean;
  /** An explicit open's pending request for this tile, consumed here. */
  readonly connectRequest: number | null;
  /** Called when this tile sends `simulator.open` for its own simulator. */
  readonly onOpened: () => void;
}) {
  const {
    node,
    viewTabId,
    epicId,
    hostId,
    state,
    autoAttach,
    connectRequest,
    onOpened,
  } = props;
  const hostClient = useTabHostClient();
  const { openTile } = useEpicTileNavigation();
  const { open } = useOpenSimulatorTile({ hostId });
  const { mutation, supported } = useSimulatorOpenMutation(hostClient, hostId);
  const { mutate, isPending } = mutation;

  const placeTile = useCallback(
    (ref: SimulatorTileRef) => {
      openTile(tileIntent(ref, { tabId: viewTabId }, "explicit", "direct_ui"));
    },
    [openTile, viewTabId],
  );
  const openOther = useCallback(
    (simulator: SimulatorSummary) => {
      open(simulator, placeTile);
    },
    [open, placeTile],
  );
  const connect = useCallback(
    (target: SimulatorSummary) => {
      onOpened();
      mutate(
        {
          epicId,
          simulatorId: target.simulatorId,
          platform: target.platform,
          boot: true,
        },
        {
          onSuccess: (response) => {
            // The host's id is authoritative: an Android AVD becomes a serial
            // on boot, and the stream answers to the serial. This tile keeps
            // the AVD's name, so the serial gets a tile of its own beside it.
            if (response.simulator.simulatorId === node.simulatorId) return;
            placeTile(
              makeSimulatorTileRef({
                hostId,
                simulatorId: response.simulator.simulatorId,
                platform: response.simulator.platform,
                name: response.simulator.name,
              }),
            );
          },
        },
      );
    },
    [epicId, hostId, mutate, node.simulatorId, onOpened, placeTile],
  );

  const target =
    state.simulators.find(
      (simulator) => simulator.simulatorId === node.simulatorId,
    ) ?? null;
  const autoAttached = useRef(false);
  useEffect(() => {
    // The request is taken whether or not it can be acted on: a target the
    // host no longer lists has nothing to boot, and a stale request must not
    // fire on some later render.
    const requested =
      connectRequest !== null &&
      takeSimulatorConnectRequest(node.id, connectRequest);
    if (!supported || target === null) return;
    if (state.booting.includes(target.simulatorId)) return;
    if (!requested) {
      if (autoAttached.current || !autoAttach || !target.booted) return;
    }
    autoAttached.current = true;
    connect(target);
  }, [
    autoAttach,
    connect,
    connectRequest,
    node.id,
    supported,
    state.booting,
    target,
  ]);

  return (
    <SimulatorInventoryView
      hostLabel={props.hostLabel}
      simulators={state.simulators}
      booting={state.booting}
      targetSimulatorId={node.simulatorId}
      targetName={target?.name ?? node.name}
      onConnect={supported ? connect : null}
      connecting={isPending}
      onOpen={supported ? openOther : null}
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
  /**
   * Whether closing the tile also ends the session: true for one this tile
   * opened, false for one it found (an agent's, another window's). A found
   * session is ended from the sidebar row instead.
   */
  readonly closesSession: boolean;
  readonly onCloseTile: () => void;
}) {
  const { node, epicId, hostId, session, state, closesSession, onCloseTile } =
    props;
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
    if (closesSession && close.supported) {
      closeMutate({ epicId, simulatorId: node.simulatorId, shutdown: false });
    }
  }, [
    close.supported,
    closeMutate,
    closesSession,
    epicId,
    node.simulatorId,
    onCloseTile,
  ]);

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const onToggleSettings = useCallback(() => {
    setSettingsOpen((open) => !open);
  }, []);
  const onCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

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
        onToggleSettings={action.supported ? onToggleSettings : null}
        settingsOpen={settingsOpen}
        onPowerOff={shutdown.supported ? onPowerOff : null}
        powerOffPending={shutdown.mutation.isPending}
        onClose={onClose}
      />
      {/* The drawer floats over the surface rather than beside it, so a
          narrow tile keeps its full-width phone while settings are open. */}
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
        <SimulatorSurface
          platform={platform}
          simulatorName={simulatorName}
          controller={controller}
          state={streamState}
          sink={stream.sink}
          onReconnect={onReconnect}
        />
        {/* Only reachable through the toggle, which is null without the verb. */}
        {settingsOpen ? (
          <SimulatorSettingsDrawer
            client={hostClient}
            hostId={hostId}
            epicId={epicId}
            simulatorId={node.simulatorId}
            platform={platform}
            onClose={onCloseSettings}
          />
        ) : null}
      </div>
    </div>
  );
}
