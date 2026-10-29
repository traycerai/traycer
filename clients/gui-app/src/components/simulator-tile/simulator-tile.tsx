import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  SimulatorSession,
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorHardwareButton } from "@traycer/protocol/host/simulator/stream-contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
  useSimulatorConfigQuery,
  useSimulatorConfigSetMutation,
  useSimulatorInstancesQuery,
  useSimulatorOpenMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { simulatorVerbsAreV11 } from "@/lib/simulator-view/simulator-host-version";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import type { HostRpcRegistry } from "@/lib/host";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  takeSimulatorConnectRequest,
  usePendingSimulatorConnectRequest,
} from "@/lib/simulator-view/simulator-connect-requests";
import { nextOrientation } from "@/lib/simulator-view/simulator-input-encoding";
import {
  findSessionFor,
  findSimulatorForTile,
} from "@/lib/simulator-view/simulator-tile-target";
import { useSimulatorInventoryRefreshOnMount } from "@/lib/simulator-view/use-simulator-inventory-refresh";
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
import {
  useSimulatorTileClose,
  useSimulatorTileIdentity,
  useSimulatorTilePowerOff,
} from "./use-simulator-tile-session";

export interface SimulatorTileProps {
  readonly node: SimulatorTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
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
 * On a `@1.1` host the tile goes live only on the viewer's OWN person session
 * on this instance (this owner, no agent), whoever sent the open: the tile,
 * the + picker, the palette or the switcher. A restored tile that finds only
 * an agent's session sends its bare open and gets one of its own. Closing the
 * tile ends that one session (`close@1.1 { sessionId }`), which is the
 * person's one session on the instance in every window and on every device.
 *
 * On a `@1.0` host the task's session may be one this tile opened, or one it
 * found - an agent's `simulator_open`, another window's tile, a session that
 * outlived a reload. The tile remembers which: closing it ends only a session
 * it opened itself.
 *
 * Either way a tile that has been live once does not reconnect on its own
 * when the session goes away under it (the agent closed it, or the person did
 * from the panel), where a freshly restored tile does.
 */
export function SimulatorTile(props: SimulatorTileProps) {
  const { node, viewTabId, tileId, epicId } = props;
  const hostId = useTabHostId();
  const reachability = useHostReachability(hostId);
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  // The stream alone never starts the hub, so a restored tile would sit on an
  // inventory the host has not read yet with nothing to attach to.
  useSimulatorInventoryRefreshOnMount({ hostId, sessions });
  const closeTile = useCloseCanvasTileWithNestedFocus(
    viewTabId,
    tileId,
    node.instanceId,
  );
  const hostLabel = reachability.hostLabel;
  const state = sessions.state;
  const hostClient = useTabHostClient();
  const viewerUserId = useRequestContextUserId(hostClient);
  const v11 = simulatorVerbsAreV11(
    useHostNegotiatedMethodVersion(hostClient, "simulator.open"),
  );
  // Nothing about the host's verbs is decided while no handshake has
  // completed. Reading that `null` as `@1.0` would match an agent's session
  // as this viewer's, and a snapshot landing in that window latches
  // `wasLive`, which turns the recovery open off for the tile's whole life.
  const session =
    v11 === null
      ? null
      : findSessionFor(state, node.simulatorId, v11, viewerUserId);
  const { openedHere, onOpened, wasLive } = useSessionMemory(session);
  const connectRequest = usePendingSimulatorConnectRequest(node.id);
  useEffect(() => {
    // A row click on a simulator this tile already shows live: nothing to
    // connect, and the request must not fire later when the session ends.
    if (connectRequest === null || session === null) return;
    takeSimulatorConnectRequest(node.id, connectRequest);
  }, [connectRequest, node.id, session]);
  const { openTile } = useEpicTileNavigation();
  const placeTile = useCallback(
    (ref: SimulatorTileRef) => {
      openTile(tileIntent(ref, { tabId: viewTabId }, "explicit", "direct_ui"));
    },
    [openTile, viewTabId],
  );
  const connection = useSimulatorConnect({
    client: hostClient,
    hostId,
    epicId,
    node,
    session,
    onOpened,
    placeTile,
  });

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
          title={`Couldn't reach the mobile simulators on ${hostLabel}`}
          reason={sessions.errorMessage}
          onRetry={sessions.retry}
        />
      );
    }
    return <SimulatorLoadingView hostLabel={hostLabel} />;
  }
  const notReady = simulatorNotReadyView({
    state,
    hostId,
    hostLabel,
    onRetry: sessions.refresh,
  });
  if (notReady !== null) return notReady;
  // Everything below turns on which verbs the host speaks, so the tile waits
  // for the answer rather than acting on the older of the two readings.
  if (v11 === null) return <SimulatorLoadingView hostLabel={hostLabel} />;
  if (session === null) {
    return (
      <SimulatorInventoryGate
        node={node}
        hostId={hostId}
        hostLabel={hostLabel}
        state={state}
        autoAttach={!wasLive}
        connectRequest={connectRequest}
        onConnect={connection.supported ? connection.connect : null}
        connecting={connection.connecting}
        onPlaceTile={placeTile}
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
      v11={v11}
      closesSession={v11 || openedHere}
      onCloseTile={closeTile}
    />
  );
}

/**
 * What the host's simulator subsystem says before any session can exist: no
 * platform or no pack, the pack still arriving or failed, the hub stopped.
 * Null once the machine is ready and the tile's own state decides.
 */
function simulatorNotReadyView(args: {
  readonly state: SimulatorState;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly onRetry: () => void;
}): ReactNode {
  const { state, hostLabel } = args;
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
      <SimulatorSetupGate
        hostId={args.hostId}
        hostLabel={hostLabel}
        state={state}
      />
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
        title={`Couldn't set up mobile simulators on ${hostLabel}`}
        reason={state.packState.reason}
        onRetry={args.onRetry}
      />
    );
  }
  if (state.hubState.kind === "failed") {
    return (
      <SimulatorFailedView
        title={`Mobile simulators stopped on ${hostLabel}`}
        reason={state.hubState.lastError}
        onRetry={args.onRetry}
      />
    );
  }
  return null;
}

/**
 * What the tile remembers about its session across the inventory and live
 * views: whether the host answered a `simulator.open` THIS tile sent (never
 * a connect request it merely consumed, nor an open that failed), and
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

/**
 * This tile's `simulator.open`, held by the tile rather than by the inventory
 * gate that triggers it: the session the host records usually reaches the
 * tile on the sessions stream BEFORE the RPC answers, and the gate unmounts
 * for the live view at that moment. A mutation observer that unmounts has
 * its per-call callbacks skipped, so the answer - which is what makes the
 * session this tile's own, and what carries an Android serial - has to land
 * on an observer that outlives the gate.
 *
 * `connecting` is the inventory's "in flight" from the person's side: set
 * when this tile sends an open, cleared when that open settles OR when the
 * session shows up on the stream, whichever is first. The stream is what the
 * open is for, so a session that arrives - and may later end under the tile
 * through the stall path - is the open having done its work, whatever the
 * RPC still owes; a tile that kept waiting on the RPC alone showed a disabled
 * "Boot and connect" over an inventory the host reported idle.
 */
function useSimulatorConnect(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly epicId: string;
  readonly node: SimulatorTileRef;
  /** The task's session on this tile's simulator, as the stream reports it. */
  readonly session: SimulatorSession | null;
  /** The host answered an open this tile sent. */
  readonly onOpened: () => void;
  readonly placeTile: (ref: SimulatorTileRef) => void;
}): {
  readonly connect: (target: SimulatorSummary) => void;
  readonly connecting: boolean;
  readonly supported: boolean;
} {
  const { client, hostId, epicId, node, session, onOpened, placeTile } = args;
  const { mutation, supported } = useSimulatorOpenMutation(client, hostId);
  const { mutateAsync } = mutation;
  const [awaiting, setAwaiting] = useState(false);
  // During render (React's "storing information from previous renders"): the
  // session the open asked for is here, so nothing is awaited any more.
  if (awaiting && session !== null) setAwaiting(false);
  const connect = useCallback(
    (target: SimulatorSummary) => {
      setAwaiting(true);
      // The answer is read off the mutation's OWN promise, never off
      // `mutate`'s per-call callbacks. Those reach only an observer that is
      // still attached to the mutation, and the open is usually sent from the
      // gate's MOUNT effect; in development React runs mount effects twice,
      // and the unsubscribe between the two runs detaches this observer from
      // the mutation it had just started, so its success never arrived and a
      // tile that booted its own simulator read as having merely attached.
      // The failure itself is already toasted by the mutation; here it only
      // ends the wait.
      void mutateAsync({
        epicId,
        simulatorId: target.simulatorId,
        platform: target.platform,
        boot: true,
      })
        .then(
          (response) => {
            onOpened();
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
          () => undefined,
        )
        .finally(() => {
          setAwaiting(false);
        });
    },
    [epicId, hostId, mutateAsync, node.simulatorId, onOpened, placeTile],
  );
  return { connect, connecting: awaiting, supported };
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
  const { mutate, isPending } = mutation;
  const onEnabledChange = useCallback(
    (enabled: boolean) => {
      mutate({ enabled });
    },
    [mutate],
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
  readonly hostId: string;
  readonly hostLabel: string;
  readonly state: SimulatorState;
  /** Connect a booted target without a click; false once this tile has been live. */
  readonly autoAttach: boolean;
  /** An explicit open's pending request for this tile, consumed here. */
  readonly connectRequest: number | null;
  /** Sends this tile's `simulator.open`; `null` when the host lacks the verb. */
  readonly onConnect: ((target: SimulatorSummary) => void) | null;
  readonly connecting: boolean;
  readonly onPlaceTile: (ref: SimulatorTileRef) => void;
}) {
  const {
    node,
    hostId,
    state,
    autoAttach,
    connectRequest,
    onConnect,
    connecting,
    onPlaceTile,
  } = props;
  const { open } = useOpenSimulatorTile({ hostId });
  const openOther = useCallback(
    (simulator: SimulatorSummary) => {
      open(simulator, onPlaceTile);
    },
    [open, onPlaceTile],
  );
  // The host-wide read is what resolves an Android clone still booted with no
  // session left on it - this task's `sessions` no longer name its serial.
  // Polled while the tile is on screen, because an instance powering off on
  // its idle deadline is not pushed anywhere.
  const hostClient = useTabHostClient();
  const visible = useTileBodyVisible();
  const hostInstances = useSimulatorInstancesQuery(hostClient, hostId, visible);

  // By id, or for an Android serial whose emulator has exited, the cold AVD
  // row of the same name: that is what "Boot and connect" boots again. A
  // clone has no row of its own, so its instance is resolved out of the
  // source's `instances` - for Android, through whichever read names its key
  // and this tile's serial together.
  const target = findSimulatorForTile(
    state.simulators,
    node,
    state.sessions,
    hostInstances.data?.instances ?? [],
  );
  const autoAttached = useRef(false);
  useEffect(() => {
    // The request is taken whether or not it can be acted on: a target the
    // host no longer lists has nothing to boot, and a stale request must not
    // fire on some later render.
    const requested =
      connectRequest !== null &&
      takeSimulatorConnectRequest(node.id, connectRequest);
    if (onConnect === null || target === null) return;
    if (state.booting.includes(target.simulatorId)) return;
    if (!requested) {
      if (autoAttached.current || !autoAttach || !target.booted) return;
    }
    autoAttached.current = true;
    onConnect(target);
  }, [autoAttach, connectRequest, node.id, onConnect, state.booting, target]);

  return (
    <SimulatorInventoryView
      hostLabel={props.hostLabel}
      simulators={state.simulators}
      booting={state.booting}
      target={target}
      targetName={target?.name ?? node.name}
      onConnect={onConnect}
      connecting={connecting}
      onOpen={onConnect === null ? null : openOther}
    />
  );
}

function LiveSimulatorTile(props: {
  readonly node: SimulatorTileRef;
  readonly epicId: string;
  readonly hostId: string;
  readonly session: SimulatorSession;
  readonly state: SimulatorState;
  /** The host speaks `@1.1`: session ids, `simulator.powerOff`. */
  readonly v11: boolean;
  /**
   * Whether closing the tile also ends the session. On a `@1.1` host always:
   * the session is the viewer's own person session, whoever sent the open.
   * On a `@1.0` host only for one this tile opened, not one it found (an
   * agent's, another window's), which is ended from the panel row instead.
   */
  readonly closesSession: boolean;
  readonly onCloseTile: () => void;
}) {
  const {
    node,
    epicId,
    hostId,
    session,
    state,
    v11,
    closesSession,
    onCloseTile,
  } = props;
  const hostClient = useTabHostClient();
  const hostEntry = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const streamClient = useHostStreamClientFor(hostEntry, auth);
  const visible = useTileBodyVisible();
  const { instanceKey, simulatorName, version, drivenByAgent } =
    useSimulatorTileIdentity({ hostId, node, session, state });
  const platform = session.platform;

  const stream = useSimulatorStream({
    client: streamClient,
    epicId,
    simulatorId: node.simulatorId,
    platform,
    visible,
  });
  const { controller, state: streamState } = stream;

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

  const onClose = useSimulatorTileClose({
    client: hostClient,
    hostId,
    epicId,
    node,
    session,
    v11,
    closesSession,
    onCloseTile,
  });
  const powerOff = useSimulatorTilePowerOff({
    client: hostClient,
    hostId,
    epicId,
    node,
    instanceKey,
    platform: session.platform,
    v11,
    onCloseTile,
  });

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
        version={version}
        drivenByAgent={drivenByAgent}
        onPressButton={inputReady ? onPressButton : null}
        onRotate={rotateReady ? onRotate : null}
        rotatePending={platform === "android" && action.mutation.isPending}
        onScreenshot={screenshot.take}
        screenshotPending={screenshot.isPending}
        onToggleSettings={action.supported ? onToggleSettings : null}
        settingsOpen={settingsOpen}
        onPowerOff={powerOff.onPowerOff}
        powerOffEndsEveryTask={v11}
        powerOffPending={powerOff.pending}
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
      <ConfirmDestructiveDialog
        open={powerOff.confirmingAgent}
        onOpenChange={powerOff.setConfirmingAgent}
        title={`Power off ${simulatorName}?`}
        description="An agent is using it right now. Powering it off ends every task's session on it and stops the agent's work there."
        cascadeSummary={null}
        actionLabel="Power off"
        isPending={powerOff.pending}
        blockedReason={null}
        onConfirm={powerOff.confirmAgent}
      />
    </div>
  );
}
