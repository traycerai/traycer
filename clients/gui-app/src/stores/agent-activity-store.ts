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
  AgentActivityCloudSyncStatus,
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
 *
 * The slice KEY is the host the stream was opened against. Upstream's flat
 * store carried that as a separate `servingHostId` field so a consumer holding
 * a session bound to a DIFFERENT host could tell a narrow union apart from one
 * that happens to cover it; here that question is answered by looking the
 * host's own slice up ({@link agentActivityPlaneCoversHost}).
 */
export interface HostAgentActivity {
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
   * Whether a `state` frame has landed since this host's stream last became
   * `open`.
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
   * THE INVARIANT: only a `state` frame sets this true, and EVERY write that
   * moves `connectionStatus` off `open` sets it false. That is why the status
   * is written through {@link noteAgentActivityConnectionStatus} /
   * {@link markAgentActivityReconnecting} and never with a bare `setState` -
   * a caller that moves the status by hand leaves a stale attestation behind,
   * which is the whole defect this field exists to close.
   */
  readonly stateFrameSeenThisEpoch: boolean;
}

const EMPTY_HOST_ACTIVITY: HostAgentActivity = Object.freeze({
  servedBy: null,
  connectionStatus: "connecting",
  cloudSyncStatus: null,
  byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
  stateFrameSeenThisEpoch: false,
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
 * Retire ONE host's current epoch's health claim: what is on record was
 * reported by a session that is no longer the one being read. Called at both
 * ends of a replacement - opening the next epoch and disposing this one - so
 * neither leaves a live-looking reading behind.
 *
 * `servedBy` and `byEpic` deliberately survive (see the field docs); the
 * frame marker is what says the surviving union has not been re-attested.
 */
function retireHostEpochHealthClaim(hostId: string): void {
  patchHost(hostId, (current) => ({
    ...current,
    connectionStatus: "connecting",
    cloudSyncStatus: null,
    stateFrameSeenThisEpoch: false,
  }));
}

/**
 * THE way a host slice's connection status moves. Every caller goes through
 * it, because the status and the union's attestation marker are one fact in
 * two fields and only this function keeps them consistent:
 *
 * - A PERMANENT `closed` retires the whole reading. The union is per-user,
 *   but a closed stream is the one state in which the host explicitly stops
 *   standing behind it, so `byEpic` empties here and nowhere else.
 * - A `closed` the reopen scheduler is about to dial through means the socket
 *   died, not that the agents stopped - replacing the authoritative snapshot
 *   with an empty map there turns lost visibility into observed idleness, the
 *   exact false-idle this multi-host stream exists to prevent. The retained
 *   snapshot keeps its rows but loses its plane (`servedBy`) and its
 *   attestation; the reopened session's own frame replaces it.
 * - Any other non-`open` status (`connecting`, `reconnecting`) keeps the
 *   union - a dropped socket does not stop agents from working, and the
 *   presence surfaces would flicker - but drops the attestation: whatever
 *   reconnects has to say so again with a frame of its own.
 * - `open` alone attests nothing. It is a socket, not an answer; the `state`
 *   frame is what sets the marker.
 *
 * The wipe is scoped to THIS host. Wiping the whole map would make one remote
 * host's disconnect erase the local host's live agents, which is the mirror
 * image of the defect the host dimension fixed.
 */
export function noteAgentActivityConnectionStatus(
  hostId: string,
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): void {
  patchHost(hostId, (current) => {
    if (status === "open") {
      return { ...current, connectionStatus: status };
    }
    if (status !== "closed") {
      return {
        ...current,
        connectionStatus: status,
        stateFrameSeenThisEpoch: false,
      };
    }
    if (isReopenableHostStreamClose(reason)) {
      return {
        ...current,
        connectionStatus: status,
        servedBy: null,
        stateFrameSeenThisEpoch: false,
      };
    }
    return {
      connectionStatus: status,
      servedBy: null,
      cloudSyncStatus: null,
      byEpic: EMPTY_AGENT_ACTIVITY_BY_EPIC,
      stateFrameSeenThisEpoch: false,
    };
  });
}

/**
 * Opens the activity stream for ONE host and writes into that host's slice.
 *
 * `hostId` is required and is the whole point of the change: without it the
 * second caller silently replaced the first caller's data. It is also what
 * {@link agentActivityPlaneCoversHost} answers from, so it is known before
 * the socket does anything and needs no re-assertion on a reopen - the reopen
 * lane dials into the same slice.
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
  retireHostEpochHealthClaim(hostId);
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
          patchHost(hostId, (current) => ({
            ...current,
            servedBy,
            cloudSyncStatus,
            byEpic: reconcileAgentActivityByEpic(byEpic, current.byEpic),
            stateFrameSeenThisEpoch: true,
          }));
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client) return;
          noteAgentActivityConnectionStatus(hostId, status, reason);
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
    retireHostEpochHealthClaim(hostId);
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
 * hold is now stale" is what that hook actually means. Moving off `open` also
 * drops each slice's attestation, exactly as
 * {@link noteAgentActivityConnectionStatus} does for one host: a hand-written
 * status write would leave the cap's busy gate vouching with a union the
 * dropped connection attested.
 */
export function markAgentActivityReconnecting(): void {
  useAgentActivityStore.setState((state) => {
    if (state.byHost.size === 0) return state;
    // Identity is load-bearing here, so a no-op write is not free: `patchHost`
    // already skips them, and the merge cache is keyed on the `byHost`
    // snapshot. Replacing every slice when they all already read
    // `reconnecting` discards that cache and re-renders every activity
    // consumer with unchanged data - once per callback, and a flapping link
    // delivers a stream of them.
    let changed = false;
    for (const host of state.byHost.values()) {
      if (
        host.connectionStatus !== "reconnecting" ||
        host.stateFrameSeenThisEpoch
      ) {
        changed = true;
        break;
      }
    }
    if (!changed) return state;
    const next = new Map<string, HostAgentActivity>();
    for (const [hostId, host] of state.byHost) {
      next.set(hostId, {
        ...host,
        connectionStatus: "reconnecting",
        stateFrameSeenThisEpoch: false,
      });
    }
    return { byHost: next };
  });
}

/**
 * Whether ONE host's slice can currently vouch for what it reports: its
 * stream is open, that stream has re-attested its union with a frame of its
 * own (a raw transport open proves nothing, and both a replacement stream and
 * an in-place reconnect leave the previous connection's `servedBy` and
 * `byEpic` on record - see `stateFrameSeenThisEpoch`), and the host did not
 * stamp the union with a cloud link that was `reconnecting` / `disconnected`
 * (other hosts' agents are dropped from the union the instant that socket
 * closes, so an epic served elsewhere reads idle).
 *
 * A `null` cloud stamp still ANSWERS: it is a true statement about the host
 * that made it, and refusing it would make every install without a cloud link
 * read as blind. What it does not do is prove the union reaches other hosts -
 * that is {@link agentActivityPlaneSpansFleet}, which the caller consults
 * separately for anything that may live on another machine.
 */
function hostActivityAnswers(host: HostAgentActivity): boolean {
  return (
    host.connectionStatus === "open" &&
    host.stateFrameSeenThisEpoch &&
    host.cloudSyncStatus !== "reconnecting" &&
    host.cloudSyncStatus !== "disconnected"
  );
}

/**
 * Whether the activity plane can currently vouch for "no agent is working in
 * this epic" - true when at least one host's slice answers
 * ({@link hostActivityAnswers}). Which hosts that answer actually reaches is
 * {@link agentActivityPlaneCoversHost}'s question; this one is the gate every
 * caller reads first.
 *
 * Read by the epic session registry's cap-eviction guard: an unreadable plane
 * must answer "busy" for every epic, because the alternative is evicting an
 * epic whose agent is mid-turn on the strength of an empty map that only
 * says the stream closed.
 */
export function agentActivityPlaneAnswers(): boolean {
  for (const host of useAgentActivityStore.getState().byHost.values()) {
    if (hostActivityAnswers(host)) return true;
  }
  return false;
}

/**
 * Whether some union the plane is vouching with covers the whole fleet, not
 * just the host's own agents.
 *
 * A host builds its union, so it can only include another host's agents when
 * it can reach the cloud, and ONE value says it did: a `connected` stamp.
 * Everything else is narrow, `null` included - that is NO CLAIM, covering a
 * host with no cloud link and a host on `agent.activity.subscribe@1.0`, which
 * predates the field and cannot report a link it has lost. `servedBy` is not
 * consulted either: a `"cloud"` plane on that older minor arrives with the
 * same absent stamp, so reading it as fleet-wide would trust exactly the
 * frame that cannot say otherwise. Callers asking about an entity that may
 * live on ANOTHER host must treat a narrow union's silence as "unknown",
 * never as "idle".
 *
 * Only an ANSWERING slice's stamp counts. Upstream's flat store could leave
 * that to the caller's `agentActivityPlaneAnswers` gate because there was one
 * slice; with several, a `connected` stamp left on a slice whose stream has
 * since dropped to `reconnecting` must not vouch for the fleet while a
 * different host's slice is what makes the plane answer.
 *
 * Deliberately separate from {@link agentActivityPlaneAnswers}: a narrow union
 * is perfectly good evidence about the host that built it, and folding this
 * into the health predicate would make every install without a cloud link
 * read as blind.
 */
export function agentActivityPlaneSpansFleet(): boolean {
  for (const host of useAgentActivityStore.getState().byHost.values()) {
    if (hostActivityAnswers(host) && host.cloudSyncStatus === "connected") {
      return true;
    }
  }
  return false;
}

/**
 * Whether the current union is evidence about `hostId` specifically - either
 * because some answering union spans the fleet
 * ({@link agentActivityPlaneSpansFleet}), or because `hostId`'s OWN slice is
 * answering: that host built its union itself.
 *
 * The registry can hold sessions bound to hosts other than the ones serving
 * an activity stream, and a narrow union says nothing about any of them - so
 * this is the predicate a caller with a SPECIFIC session's host in hand
 * should read, never `agentActivityPlaneSpansFleet` alone (which answers a
 * host-agnostic "does this reach everywhere", not "does this reach HERE").
 */
export function agentActivityPlaneCoversHost(hostId: string): boolean {
  if (agentActivityPlaneSpansFleet()) return true;
  const host = useAgentActivityStore.getState().byHost.get(hostId);
  return host !== undefined && hostActivityAnswers(host);
}

/**
 * Fires when {@link agentActivityPlaneAnswers} or
 * {@link agentActivityPlaneSpansFleet} flips, in either direction. Separate
 * from {@link subscribeAgentActivity} because that one fires on EVERY
 * `byHost` replacement - a stream re-open with an empty union moves only the
 * health fields, and a working-set change moves neither predicate. Both
 * predicates are here because the cap's busy gate reads both, and a consumer
 * woken for one and not the other would sit on a stale verdict until an
 * unrelated write.
 *
 * `agentActivityPlaneCoversHost` is deliberately not a third tracked field:
 * a slice only starts answering through a status-and-frame pair that flips
 * `answers` or `spansFleet` for the plane as a whole, or - when another slice
 * already answers - through a write the caller's own `subscribeAgentActivity`
 * subscription sees (the same `byHost` replacement).
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

/** The host id the single-stream test harness writes under. */
export const TEST_LOCAL_ACTIVITY_HOST_ID = "test-local-host";

export function __setAgentActivityStateForTests(
  byEpic: AgentActivityByEpic,
  servedBy: AgentActivityServedBy,
  cloudSyncStatus: AgentActivityCloudSyncStatus | null,
): void {
  __setHostAgentActivityStateForTests(
    TEST_LOCAL_ACTIVITY_HOST_ID,
    byEpic,
    servedBy,
    cloudSyncStatus,
  );
}

/**
 * Drives ONE named host's slice - including a remote one. Counts as that
 * host's own `state` frame, so it attests the union it writes.
 */
export function __setHostAgentActivityStateForTests(
  hostId: string,
  byEpic: AgentActivityByEpic,
  servedBy: AgentActivityServedBy,
  cloudSyncStatus: AgentActivityCloudSyncStatus | null,
): void {
  patchHost(hostId, (current) => ({
    ...current,
    servedBy,
    cloudSyncStatus,
    byEpic: reconcileAgentActivityByEpic(byEpic, current.byEpic),
    stateFrameSeenThisEpoch: true,
  }));
}

/**
 * Puts the plane in the state a live cloud-connected app is in: the local
 * test host's stream open, this epoch's own `state` frame received, and a
 * union that spans the fleet. Exists because the cap's busy gate fails CLOSED
 * on a plane that cannot vouch, so any suite that exercises eviction has to
 * say the plane is answering - and saying it by hand means restating a truth
 * table that only this module owns. A suite about the NARROW-union arm sets
 * the fields itself through {@link __setHostAgentActivityHealthForTests}.
 */
export function __setAgentActivityPlaneAnsweringForTests(): void {
  __setHostAgentActivityHealthForTests(TEST_LOCAL_ACTIVITY_HOST_ID, {
    connectionStatus: "open",
    servedBy: "cloud",
    cloudSyncStatus: "connected",
    stateFrameSeenThisEpoch: true,
  });
}

/**
 * Writes ONE host's health fields directly, creating the slice on first use.
 * For suites pinning the plane predicates' truth table; production moves these
 * fields only through the stream callbacks above.
 */
export function __setHostAgentActivityHealthForTests(
  hostId: string,
  patch: Partial<Omit<HostAgentActivity, "byEpic">> & {
    readonly byEpic?: ReadonlyMap<string, EpicAgentActivity>;
  },
): void {
  patchHost(hostId, (current) => ({ ...current, ...patch }));
}

export function __resetAgentActivityStoreForTests(): void {
  useAgentActivityStore.getState().reset();
}
