import { useMemo } from "react";
import { create } from "zustand";
import { AgentActivityStreamClient } from "@traycer-clients/shared/host-transport/agent-activity-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  AgentActivityCloudSyncStatus,
  AgentActivityServedBy,
} from "@traycer/protocol/host/agent/activity";
import {
  EMPTY_AGENT_ACTIVITY_BY_EPIC,
  EMPTY_EPIC_AGENT_ACTIVITY,
  reconcileAgentActivityByEpic,
  type EpicAgentActivity,
} from "@/lib/agent-activity";
import {
  isReopenableHostStreamClose,
  type HostReconnectEngine,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";

interface AgentActivityState {
  readonly servedBy: AgentActivityServedBy | null;
  readonly connectionStatus: StreamConnectionStatus;
  /**
   * Host cloud-link stamp on the latest `state` frame.
   * `null` is no claim and must not be read as connected.
   */
  readonly cloudSyncStatus: AgentActivityCloudSyncStatus | null;
  readonly byEpic: ReadonlyMap<string, EpicAgentActivity>;
  /**
   * Only `onState` sets this true; every write that moves `connectionStatus` off
   * `open` must go through {@link noteAgentActivityConnectionStatus} so this is set false.
   */
  readonly stateFrameSeenThisEpoch: boolean;
  /**
   * Host this epoch's stream is open against. Re-asserted at the start of every
   * dial, including reopen; never inferred from `servedBy`.
   */
  readonly servingHostId: string | null;
  reset(): void;
}

export const useAgentActivityStore = create<AgentActivityState>()((set) => ({
  servedBy: null,
  connectionStatus: "connecting",
  cloudSyncStatus: null,
  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
  stateFrameSeenThisEpoch: false,
  servingHostId: null,
  reset: () => {
    set({
      servedBy: null,
      connectionStatus: "connecting",
      cloudSyncStatus: null,
      byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
      stateFrameSeenThisEpoch: false,
      servingHostId: null,
    });
  },
}));

/** Drop this epoch's health claim. `servedBy` and `byEpic` survive. */
function retireEpochHealthClaim(): void {
  useAgentActivityStore.setState({
    connectionStatus: "connecting",
    cloudSyncStatus: null,
    stateFrameSeenThisEpoch: false,
  });
}

/**
 * `closed` retires the union; other non-open drops attestation; `open` attests
 * nothing until `onState`.
 */
export function noteAgentActivityConnectionStatus(
  status: StreamConnectionStatus,
): void {
  if (status === "closed") {
    useAgentActivityStore.setState({
      connectionStatus: status,
      servedBy: null,
      cloudSyncStatus: null,
      byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
      stateFrameSeenThisEpoch: false,
      servingHostId: null,
    });
    return;
  }
  if (status === "open") {
    useAgentActivityStore.setState({ connectionStatus: status });
    return;
  }
  useAgentActivityStore.setState({
    connectionStatus: status,
    stateFrameSeenThisEpoch: false,
  });
}

export function openAgentActivityStream(
  reconnectEngine: HostReconnectEngine,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
  servingHostId: string,
): () => void {
  // New epoch makes no health claim until its own session speaks. byEpic is not
  // cleared: the cloud union is per-user.
  retireEpochHealthClaim();
  let disposed = false;
  let currentClient: AgentActivityStreamClient | null = null;
  const reopenScheduler = reconnectEngine.openReopenLane(() => {
    const client = currentClient;
    currentClient = null;
    client?.close();
    openClient();
  }, isReopenableHostStreamClose);

  function openClient(): void {
    if (disposed) return;
    // Re-assert on every dial: closed nulls this field and reopen calls openClient
    // directly, skipping the outer path.
    useAgentActivityStore.setState({ servingHostId });
    let client: AgentActivityStreamClient | null = null;
    client = new AgentActivityStreamClient({
      wsStreamClient,
      callbacks: {
        onState: (servedBy, byEpic, cloudSyncStatus) => {
          if (currentClient !== client) return;
          // A state frame is usable-session proof. A raw transport open must not
          // collapse retry backoff.
          reopenScheduler.resetBackoff();
          useAgentActivityStore.setState((state) => ({
            servedBy,
            cloudSyncStatus,
            byEpic: reconcileAgentActivityByEpic(byEpic, state.byEpic),
            stateFrameSeenThisEpoch: true,
          }));
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client) return;
          noteAgentActivityConnectionStatus(status);
          if (status === "closed") {
            reopenScheduler.scheduleAfterClose(reason);
            if (isUnauthorized(reason)) onAuthError?.();
          }
        },
      },
    });
    currentClient = client;
  }

  openClient();
  return () => {
    disposed = true;
    reopenScheduler.dispose();
    const client = currentClient;
    currentClient = null;
    client?.close();
    // Close is swallowed by the identity guard; retire health explicitly.
    retireEpochHealthClaim();
  };
}

function isUnauthorized(reason: StreamCloseReason | null): boolean {
  return (
    reason?.kind === "fatalError" && reason.details.code === "UNAUTHORIZED"
  );
}

export function useEpicAgentActivity(epicId: string | null): EpicAgentActivity {
  const selector = useMemo(() => makeSelectEpicAgentActivity(epicId), [epicId]);
  return useAgentActivityStore(selector);
}

function makeSelectEpicAgentActivity(epicId: string | null) {
  return (state: AgentActivityState): EpicAgentActivity => {
    if (epicId === null) return EMPTY_EPIC_AGENT_ACTIVITY;
    return state.byEpic.get(epicId) ?? EMPTY_EPIC_AGENT_ACTIVITY;
  };
}

export function getEpicAgentActivity(epicId: string): EpicAgentActivity {
  return (
    useAgentActivityStore.getState().byEpic.get(epicId) ??
    EMPTY_EPIC_AGENT_ACTIVITY
  );
}

export function subscribeAgentActivity(listener: () => void): () => void {
  let previous = useAgentActivityStore.getState().byEpic;
  return useAgentActivityStore.subscribe((state) => {
    if (state.byEpic === previous) return;
    previous = state.byEpic;
    listener();
  });
}

/**
 * False unless open, this epoch's state frame has landed, and cloudSyncStatus is
 * not reconnecting/disconnected. A null stamp still answers.
 */
export function agentActivityPlaneAnswers(): boolean {
  const state = useAgentActivityStore.getState();
  return (
    state.connectionStatus === "open" &&
    state.stateFrameSeenThisEpoch &&
    state.cloudSyncStatus !== "reconnecting" &&
    state.cloudSyncStatus !== "disconnected"
  );
}

/**
 * Fleet-wide only when cloudSyncStatus is connected; null is no claim.
 * Narrow silence is unknown, not idle.
 */
export function agentActivityPlaneSpansFleet(): boolean {
  return useAgentActivityStore.getState().cloudSyncStatus === "connected";
}

/** Narrow union is evidence only for the serving host. */
export function agentActivityPlaneCoversHost(hostId: string): boolean {
  if (agentActivityPlaneSpansFleet()) return true;
  return useAgentActivityStore.getState().servingHostId === hostId;
}

/**
 * Wake when answers or spansFleet flips. servingHostId is not tracked: it is
 * set while answers is already false.
 */
export function subscribeAgentActivityPlaneHealth(
  listener: () => void,
): () => void {
  let previousAnswers = agentActivityPlaneAnswers();
  let previousSpansFleet = agentActivityPlaneSpansFleet();
  return useAgentActivityStore.subscribe(() => {
    const nextAnswers = agentActivityPlaneAnswers();
    const nextSpansFleet = agentActivityPlaneSpansFleet();
    if (
      nextAnswers === previousAnswers &&
      nextSpansFleet === previousSpansFleet
    ) {
      return;
    }
    previousAnswers = nextAnswers;
    previousSpansFleet = nextSpansFleet;
    listener();
  });
}

export function __setAgentActivityStateForTests(
  byEpic: Parameters<typeof reconcileAgentActivityByEpic>[0],
  servedBy: AgentActivityServedBy,
  cloudSyncStatus: AgentActivityCloudSyncStatus | null,
): void {
  useAgentActivityStore.setState((state) => ({
    servedBy,
    cloudSyncStatus,
    byEpic: reconcileAgentActivityByEpic(byEpic, state.byEpic),
    stateFrameSeenThisEpoch: true,
  }));
}

/** Puts the plane in the answering, fleet-spanning state eviction tests need. */
export function __setAgentActivityPlaneAnsweringForTests(): void {
  useAgentActivityStore.setState({
    connectionStatus: "open",
    servedBy: "cloud",
    cloudSyncStatus: "connected",
    stateFrameSeenThisEpoch: true,
  });
}

export function __resetAgentActivityStoreForTests(): void {
  useAgentActivityStore.getState().reset();
}
