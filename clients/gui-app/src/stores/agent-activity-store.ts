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
  AgentActivityByEpic,
  AgentActivityServedBy,
} from "@traycer/protocol/host/agent/activity";
import {
  EMPTY_AGENT_ACTIVITY_BY_EPIC,
  EMPTY_EPIC_AGENT_ACTIVITY,
  mergeEpicAgentActivity,
  reconcileAgentActivityByEpic,
  type EpicAgentActivity,
} from "@/lib/agent-activity";
import {
  isReopenableHostStreamClose,
  type HostReconnectEngine,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";

/**
 * One host's agent-activity view.
 *
 * ## Why the store gained a host dimension (`s5-parity-gaps` gap 1)
 *
 * There used to be ONE flat `byEpic` map, fed by ONE stream that production
 * hard-coded to the local host. Every `state` frame is a full REPLACEMENT, so
 * a second stream could only clobber the first - the store literally could not
 * hold two hosts' activity at once. That is why "a remote host running an
 * agent on a cloud-homed epic" rendered as nothing happening, and why a test
 * for it could not even be written: the shape had nowhere to put the fact.
 *
 * Keying by host makes each stream's replacement scoped to its own slice, so
 * the reads below can union across hosts. It also keeps the plane fact
 * per-host, which it always was - `servedBy` is stamped by the host that sent
 * the frame, and collapsing two hosts' planes into one field was only safe
 * while there was exactly one host.
 */
export interface HostAgentActivity {
  readonly servedBy: AgentActivityServedBy | null;
  readonly connectionStatus: StreamConnectionStatus;
  readonly byEpic: ReadonlyMap<string, EpicAgentActivity>;
}

const EMPTY_HOST_ACTIVITY: HostAgentActivity = Object.freeze({
  servedBy: null,
  connectionStatus: "connecting",
  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
});

const EMPTY_BY_HOST: ReadonlyMap<string, HostAgentActivity> = new Map<
  string,
  HostAgentActivity
>();

interface AgentActivityState {
  readonly byHost: ReadonlyMap<string, HostAgentActivity>;
  reset(): void;
  resetHost(hostId: string): void;
}

export const useAgentActivityStore = create<AgentActivityState>()((set) => ({
  byHost: EMPTY_BY_HOST,
  reset: () => {
    set({ byHost: EMPTY_BY_HOST });
  },
  resetHost: (hostId) => {
    set((state) => {
      if (!state.byHost.has(hostId)) return state;
      const next = new Map(state.byHost);
      next.delete(hostId);
      return { byHost: next };
    });
  },
}));

function patchHost(
  hostId: string,
  patch: (current: HostAgentActivity) => HostAgentActivity,
): void {
  useAgentActivityStore.setState((state) => {
    const current = state.byHost.get(hostId) ?? EMPTY_HOST_ACTIVITY;
    const updated = patch(current);
    if (updated === current) return state;
    const next = new Map(state.byHost);
    next.set(hostId, updated);
    return { byHost: next };
  });
}

/**
 * Opens the activity stream for ONE host and writes into that host's slice.
 *
 * `hostId` is required and is the whole point of the change: without it the
 * second caller silently replaced the first caller's data.
 */
export function openAgentActivityStream(
  hostId: string,
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
        onState: (servedBy, byEpic) => {
          if (currentClient !== client) return;
          // A host-stamped state frame is the usable-session proof. A raw
          // transport open can still be followed by resolver initialization
          // failure, so it must not collapse the retry backoff.
          reopenScheduler.resetBackoff();
          patchHost(hostId, (current) => ({
            ...current,
            servedBy,
            byEpic: reconcileAgentActivityByEpic(byEpic, current.byEpic),
          }));
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client) return;
          // The wipe on close is scoped to THIS host. Wiping the whole map
          // would make one remote host's disconnect erase the local host's
          // live agents, which is the mirror image of the defect being fixed.
          //
          // And it is scoped to PERMANENT closes. A close the reopen
          // scheduler is about to dial through means the socket died, not
          // that the agents stopped - replacing the authoritative snapshot
          // with an empty map there turns lost visibility into observed
          // idleness, the exact false-idle this multi-host stream exists to
          // prevent. The retained snapshot is replaced by the reopened
          // session's own state frame.
          patchHost(hostId, (current) => {
            if (status !== "closed") {
              return { ...current, connectionStatus: status };
            }
            if (isReopenableHostStreamClose(reason)) {
              return { ...current, connectionStatus: status, servedBy: null };
            }
            return {
              connectionStatus: status,
              servedBy: null,
              byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
            };
          });
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

/**
 * This epic's activity, UNIONED across every host reporting it.
 *
 * An epic is cloud-homed and can be worked from more than one machine, so the
 * question "is anything running on this epic" is not any single host's to
 * answer. The union is also what keeps the read side's signature unchanged
 * for the dozen consumers that never needed to know a host was involved.
 */
export function useEpicAgentActivity(epicId: string | null): EpicAgentActivity {
  const selector = useMemo(() => makeSelectEpicAgentActivity(epicId), [epicId]);
  return useAgentActivityStore(selector);
}

function makeSelectEpicAgentActivity(
  epicId: string | null,
): (state: AgentActivityState) => EpicAgentActivity {
  return (state: AgentActivityState): EpicAgentActivity =>
    selectEpicAgentActivity(state.byHost, epicId);
}

/**
 * Merged multi-host results, keyed by the `byHost` map that produced them.
 *
 * `selectEpicAgentActivity` runs as a Zustand selector and Zustand compares
 * selector output with `Object.is`. The single-host path returns the bucket
 * itself, so it is already identity-stable; the union path allocates. Without
 * this cache EVERY unrelated write to `byHost` - a `connectionStatus` change
 * on any host, a frame from any other host - produced a fresh merged object
 * for every two-host epic, re-rendering every consumer and rebuilding
 * `agentActivityTiers` (which keys its cache by activity identity).
 *
 * `byHost` is replaced on every write, so keying on it is exactly the right
 * invalidation, and a WeakMap lets superseded maps and their merges go away.
 */
const mergedActivityByHostMap = new WeakMap<
  ReadonlyMap<string, HostAgentActivity>,
  Map<string, EpicAgentActivity>
>();

function selectEpicAgentActivity(
  byHost: ReadonlyMap<string, HostAgentActivity>,
  epicId: string | null,
): EpicAgentActivity {
  if (epicId === null) return EMPTY_EPIC_AGENT_ACTIVITY;
  let merged: EpicAgentActivity | null = null;
  let contributors = 0;
  for (const host of byHost.values()) {
    const bucket = host.byEpic.get(epicId);
    if (bucket === undefined) continue;
    contributors += 1;
    // Identity is preserved for the single-host case, which is still the
    // overwhelmingly common one - a fresh object every read would re-render
    // every activity consumer on every unrelated store write.
    if (merged === null) {
      merged = bucket;
      continue;
    }
    if (contributors === 2) {
      const cached = mergedActivityByHostMap.get(byHost)?.get(epicId);
      if (cached !== undefined) return cached;
    }
    merged = mergeEpicAgentActivity(merged, bucket);
  }
  if (merged === null) return EMPTY_EPIC_AGENT_ACTIVITY;
  if (contributors < 2) return merged;
  let perEpic = mergedActivityByHostMap.get(byHost);
  if (perEpic === undefined) {
    perEpic = new Map<string, EpicAgentActivity>();
    mergedActivityByHostMap.set(byHost, perEpic);
  }
  perEpic.set(epicId, merged);
  return merged;
}

export function getEpicAgentActivity(epicId: string): EpicAgentActivity {
  return selectEpicAgentActivity(
    useAgentActivityStore.getState().byHost,
    epicId,
  );
}

export function subscribeAgentActivity(listener: () => void): () => void {
  let previous = useAgentActivityStore.getState().byHost;
  return useAgentActivityStore.subscribe((state) => {
    if (state.byHost === previous) return;
    previous = state.byHost;
    listener();
  });
}

/**
 * Marks every known host's view as reconnecting.
 *
 * The host-replica disconnect hook used to write one flat `connectionStatus`.
 * With a slice per host there is no single field to write, and "every view we
 * hold is now stale" is what that hook actually means.
 */
export function markAgentActivityReconnecting(): void {
  useAgentActivityStore.setState((state) => {
    if (state.byHost.size === 0) return state;
    const next = new Map<string, HostAgentActivity>();
    for (const [hostId, host] of state.byHost) {
      next.set(hostId, { ...host, connectionStatus: "reconnecting" });
    }
    return { byHost: next };
  });
}

/** The host id the single-stream test harness writes under. */
export const TEST_LOCAL_ACTIVITY_HOST_ID = "test-local-host";

export function __setAgentActivityStateForTests(
  byEpic: AgentActivityByEpic,
  servedBy: AgentActivityServedBy,
): void {
  __setHostAgentActivityStateForTests(
    TEST_LOCAL_ACTIVITY_HOST_ID,
    byEpic,
    servedBy,
  );
}

/** Drives ONE named host's slice - including a remote one. */
export function __setHostAgentActivityStateForTests(
  hostId: string,
  byEpic: AgentActivityByEpic,
  servedBy: AgentActivityServedBy,
): void {
  patchHost(hostId, (current) => ({
    ...current,
    servedBy,
    byEpic: reconcileAgentActivityByEpic(byEpic, current.byEpic),
  }));
}

export function __resetAgentActivityStoreForTests(): void {
  useAgentActivityStore.getState().reset();
}
