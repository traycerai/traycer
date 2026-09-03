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
  /**
   * Whether a `state` frame has landed since the stream last became `open`.
   *
   * The union's attestation marker, and deliberately not inferred from any
   * other field. `servedBy` and `byEpic` outlive both a stream REPLACEMENT
   * (the cloud union is per-user and survives a host switch) and an in-place
   * RECONNECT (a dropped socket goes `open` -> `reconnecting` -> `open` with
   * no `closed` in between, so nothing clears them) - in both windows the
   * union on record was attested by a connection that is no longer the one
   * being read. Anything that reads this store as evidence of what is
   * happening NOW - the cap's busy gate - must gate on the frame.
   *
   * THE INVARIANT: only `onState` sets this true, and EVERY write that moves
   * `connectionStatus` off `open` sets it false. That is why the status is
   * written through {@link noteAgentActivityConnectionStatus} and not with a
   * bare `setState` - a caller that moves the status by hand leaves a stale
   * attestation behind, which is the whole defect this field exists to close.
   */
  readonly stateFrameSeenThisEpoch: boolean;
  reset(): void;
}

export const useAgentActivityStore = create<AgentActivityState>()((set) => ({
  servedBy: null,
  connectionStatus: "connecting",
  cloudSyncStatus: null,
  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
  stateFrameSeenThisEpoch: false,
  reset: () => {
    set({
      servedBy: null,
      connectionStatus: "connecting",
      cloudSyncStatus: null,
      byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
      stateFrameSeenThisEpoch: false,
    });
  },
}));

/**
 * Retire the current epoch's health claim: what is on record was reported by
 * a session that is no longer the one being read. Called at both ends of a
 * replacement - opening the next epoch and disposing this one - so neither
 * leaves a live-looking reading behind.
 *
 * `servedBy` and `byEpic` deliberately survive (see the field docs); the
 * frame marker is what says the surviving union has not been re-attested.
 */
function retireEpochHealthClaim(): void {
  useAgentActivityStore.setState({
    connectionStatus: "connecting",
    cloudSyncStatus: null,
    stateFrameSeenThisEpoch: false,
  });
}

/**
 * THE way this store's connection status moves. Every caller goes through it,
 * because the status and the union's attestation marker are one fact in two
 * fields and only this function keeps them consistent:
 *
 * - `closed` retires the whole reading. The union is per-user, but a closed
 *   stream is the one state in which the host explicitly stops standing
 *   behind it, so `byEpic` empties here and nowhere else.
 * - Any other non-`open` status (`connecting`, `reconnecting`) keeps the
 *   union - a dropped socket does not stop agents from working, and the
 *   presence surfaces would flicker - but drops the attestation: whatever
 *   reconnects has to say so again with a frame of its own.
 * - `open` alone attests nothing. It is a socket, not an answer; `onState`
 *   is what sets the marker.
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
    // The close above is swallowed by the identity guard (`currentClient` is
    // already null), so retire the epoch's health explicitly rather than
    // leaving the last live reading behind for whatever opens next.
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
 * Whether the activity plane can currently vouch for "no agent is working in
 * this epic". False while the stream is not open, while an open stream has
 * not re-attested its union with a frame of its own (a raw transport open
 * proves nothing, and both a replacement stream and an in-place reconnect
 * leave the previous connection's `servedBy` and `byEpic` on record - see
 * `stateFrameSeenThisEpoch`), and while the host stamped the union with a
 * cloud link that was `reconnecting` / `disconnected` (other hosts' agents
 * are dropped from the union the instant that socket closes, so an epic
 * served elsewhere reads idle).
 *
 * A `null` cloud stamp still ANSWERS: it is a true statement about the host
 * that made it, and refusing it would make every install without a cloud link
 * read as blind. What it does not do is prove the union reaches other hosts -
 * that is {@link agentActivityPlaneSpansFleet}, which the caller consults
 * separately for anything that may live on another machine.
 *
 * Read by the epic session registry's cap-eviction guard: an unreadable plane
 * must answer "busy" for every epic, because the alternative is evicting an
 * epic whose agent is mid-turn on the strength of an empty map that only
 * says the stream closed.
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
 * Whether the union the plane is vouching with covers the whole fleet, not
 * just the serving host's own agents.
 *
 * The serving host builds the union, so it can only include another host's
 * agents when it can reach the cloud, and ONE value says it did: a
 * `connected` stamp. Everything else is narrow, `null` included - that is NO
 * CLAIM, covering a host with no cloud link and a host on
 * `agent.activity.subscribe@1.0`, which predates the field and cannot report
 * a link it has lost. `servedBy` is not consulted either: a `"cloud"` plane
 * on that older minor arrives with the same absent stamp, so reading it as
 * fleet-wide would trust exactly the frame that cannot say otherwise.
 * Callers asking about an entity that may live on ANOTHER host must treat a
 * narrow union's silence as "unknown", never as "idle".
 *
 * Deliberately separate from {@link agentActivityPlaneAnswers}: a narrow union
 * is perfectly good evidence about the host that built it, and folding this
 * into the health predicate would make every install without a cloud link
 * read as blind.
 */
export function agentActivityPlaneSpansFleet(): boolean {
  return useAgentActivityStore.getState().cloudSyncStatus === "connected";
}

/**
 * Fires when {@link agentActivityPlaneAnswers} or
 * {@link agentActivityPlaneSpansFleet} flips, in either direction. Separate
 * from {@link subscribeAgentActivity} because the two move on different
 * fields: a stream close empties `byEpic` (which that subscription sees) but
 * a stream re-open with an empty union keeps the same empty map and moves only
 * the health fields. Both predicates are here because the cap's busy gate
 * reads both, and a consumer woken for one and not the other would sit on a
 * stale verdict until an unrelated write.
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

/**
 * Puts the plane in the state a live cloud-connected app is in: stream open,
 * this epoch's own `state` frame received, and a union that spans the fleet.
 * Exists because the cap's busy gate fails CLOSED on a plane that cannot
 * vouch, so any suite that exercises eviction has to say the plane is
 * answering - and saying it by hand means restating a truth table that only
 * this module owns. A suite about the NARROW-union arm sets the fields
 * itself.
 */
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
