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
   * The host's cloud-link status stamped on the latest `state` frame. `null`
   * is NO CLAIM - local plane, a `1.0` host that predates the field, or no
   * frame yet - and must never be read as "connected". A `reconnecting` /
   * `disconnected` value means the union below was built while the host could
   * not see other hosts' agents: it is a true statement about what the host
   * saw, not about who is working.
   */
  readonly cloudSyncStatus: AgentActivityCloudSyncStatus | null;
  readonly byEpic: ReadonlyMap<string, EpicAgentActivity>;
  reset(): void;
}

export const useAgentActivityStore = create<AgentActivityState>()((set) => ({
  servedBy: null,
  connectionStatus: "connecting",
  cloudSyncStatus: null,
  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
  reset: () => {
    set({
      servedBy: null,
      connectionStatus: "connecting",
      cloudSyncStatus: null,
      byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
    });
  },
}));

export function openAgentActivityStream(
  /**
   * THE reconnect policy for this stream's host (redesign P4.1 /
   * connection-registry §6), acquired from the connection registry by the one
   * place that opens these streams. This store no longer constructs its own
   * scheduler: the constants, the terminal-close classification and the
   * backoff shape live once, in the engine, and each stream still gets its
   * own independent lane so a sibling stream's refusal cannot pace it.
   */
  reconnectEngine: HostReconnectEngine,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
): () => void {
  // A new stream epoch makes NO health claim until its own session speaks.
  //
  // Neither end of a replacement publishes one otherwise: `IStreamSession`'s
  // `onStatusChange` only stores the handler (it never replays the current
  // status), and the disposer below nulls `currentClient` before closing, so
  // the outgoing session's `closed` callback is rejected by its own identity
  // guard. A same-host client swap - the app-wide liveness rebuild, which
  // keeps the replica on purpose - therefore left `open` + a `connected`
  // stamp from the DEAD session readable while the new one was still
  // connecting, and a replacement that hung before its first transition kept
  // them readable indefinitely. The presence indicator that reads this state
  // would have stayed quiet through exactly the outage it exists to report.
  //
  // `byEpic` is deliberately NOT cleared here: the cloud union is per-user and
  // stays valid across a host switch (see `resetHostReplica`). Only the health
  // of the stream that reported it belongs to the epoch.
  useAgentActivityStore.setState({
    connectionStatus: "connecting",
    cloudSyncStatus: null,
  });
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
    let client: AgentActivityStreamClient | null = null;
    client = new AgentActivityStreamClient({
      wsStreamClient,
      callbacks: {
        onState: (servedBy, byEpic, cloudSyncStatus) => {
          if (currentClient !== client) return;
          // A host-stamped state frame is the usable-session proof. A raw
          // transport open can still be followed by resolver initialization
          // failure, so it must not collapse the retry backoff.
          reopenScheduler.resetBackoff();
          useAgentActivityStore.setState((state) => ({
            servedBy,
            cloudSyncStatus,
            byEpic: reconcileAgentActivityByEpic(byEpic, state.byEpic),
          }));
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client) return;
          useAgentActivityStore.setState(
            status === "closed"
              ? {
                  connectionStatus: status,
                  servedBy: null,
                  cloudSyncStatus: null,
                  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
                }
              : { connectionStatus: status },
          );
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
    // The close above is swallowed by the identity guard (`currentClient` is
    // already null), so retire the epoch's health explicitly rather than
    // leaving the last live reading behind for whatever opens next.
    useAgentActivityStore.setState({
      connectionStatus: "connecting",
      cloudSyncStatus: null,
    });
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

export function __setAgentActivityStateForTests(
  byEpic: Parameters<typeof reconcileAgentActivityByEpic>[0],
  servedBy: AgentActivityServedBy,
  cloudSyncStatus: AgentActivityCloudSyncStatus | null,
): void {
  useAgentActivityStore.setState((state) => ({
    servedBy,
    cloudSyncStatus,
    byEpic: reconcileAgentActivityByEpic(byEpic, state.byEpic),
  }));
}

export function __resetAgentActivityStoreForTests(): void {
  useAgentActivityStore.getState().reset();
}
