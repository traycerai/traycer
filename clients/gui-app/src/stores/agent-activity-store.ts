import { useMemo } from "react";
import { create } from "zustand";
import { AgentActivityStreamClient } from "@traycer-clients/shared/host-transport/agent-activity-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { AgentActivityServedBy } from "@traycer/protocol/host/agent/activity";
import {
  EMPTY_AGENT_ACTIVITY_BY_EPIC,
  EMPTY_EPIC_AGENT_ACTIVITY,
  reconcileAgentActivityByEpic,
  type EpicAgentActivity,
} from "@/lib/agent-activity";
import {
  createHostStreamReopenScheduler,
  isReopenableHostStreamClose,
} from "@/lib/host/stream-reopen";

interface AgentActivityState {
  readonly servedBy: AgentActivityServedBy | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly byEpic: ReadonlyMap<string, EpicAgentActivity>;
  reset(): void;
}

export const useAgentActivityStore = create<AgentActivityState>()((set) => ({
  servedBy: null,
  connectionStatus: "connecting",
  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
  reset: () => {
    set({
      servedBy: null,
      connectionStatus: "connecting",
      byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
    });
  },
}));

export function openAgentActivityStream(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  onAuthError: (() => void) | null,
): () => void {
  let disposed = false;
  let currentClient: AgentActivityStreamClient | null = null;
  const reopenScheduler = createHostStreamReopenScheduler(() => {
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
        onState: (servedBy, byEpic) => {
          if (currentClient !== client) return;
          // A host-stamped state frame is the usable-session proof. A raw
          // transport open can still be followed by resolver initialization
          // failure, so it must not collapse the retry backoff.
          reopenScheduler.resetBackoff();
          useAgentActivityStore.setState((state) => ({
            servedBy,
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
): void {
  useAgentActivityStore.setState((state) => ({
    servedBy,
    byEpic: reconcileAgentActivityByEpic(byEpic, state.byEpic),
  }));
}

export function __resetAgentActivityStoreForTests(): void {
  useAgentActivityStore.getState().reset();
}
