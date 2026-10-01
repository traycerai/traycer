import type {
  HostCommunicationGraphCloudFeedCursor,
  HostCommunicationGraphCloudFeedEvent,
} from "@traycer/protocol/host/epic/communication-graph";
import {
  compareCommGraphEvents,
  type CommGraphEvent,
  type CommGraphHostStatus,
  type CommGraphSnapshot,
} from "@/lib/comm-graph/comm-graph-events";
import { commGraphEventKey } from "@/lib/comm-graph/comm-graph-timeline";
import { appLogger } from "@/lib/logger";

export type CommGraphCloudAvailability =
  | "pending"
  | "available"
  | "unsupported";

const RECONNECTING_RELAY_FAILOVER_MS = 15_000;

/** The two halves of one directory update, installed together. */
export interface CommGraphRelayReconciliation {
  readonly hostIds: ReadonlyArray<string>;
  readonly readinessKeys: ReadonlyMap<string, string>;
}

export interface CommGraphCloudSubscriptionHandlers {
  readonly onAvailability: (availability: "available") => void;
  readonly onSnapshot: (
    events: ReadonlyArray<HostCommunicationGraphCloudFeedEvent>,
    headVersion: number,
    frontier: number | null,
  ) => void;
  readonly onEvent: (event: HostCommunicationGraphCloudFeedEvent) => void;
  readonly onCaughtUp: (
    cursor: HostCommunicationGraphCloudFeedCursor | null,
    headVersion: number,
  ) => void;
  readonly onStatus: (status: CommGraphHostStatus) => void;
}

export interface CommGraphCloudSubscriptionRequest {
  readonly hostId: string;
  readonly epicId: string;
  /** Read at every physical wire subscribe so reconnect resumes from applied state. */
  readonly readSinceCursor: () => HostCommunicationGraphCloudFeedCursor | null;
  readonly handlers: CommGraphCloudSubscriptionHandlers;
}

export interface CommGraphCloudSubscriptionHandle {
  readonly close: () => void;
}

export type CommGraphCloudSubscriptionOpener = (
  request: CommGraphCloudSubscriptionRequest,
) => CommGraphCloudSubscriptionHandle;

/**
 * One retained cloud-authoritative feed per epic. Relay hosts are transport
 * choices only: changing one never changes the graph authority, event set, or
 * compound cursor.
 */
export class CommGraphCloudSubscriptionManager {
  private readonly epicId: string;
  private readonly opener: CommGraphCloudSubscriptionOpener;
  private readonly onRowsPruned: (rowKeys: ReadonlySet<string>) => void;
  private readonly listeners = new Set<() => void>();
  private relayHostIds: ReadonlyArray<string> = [];
  private relayReadinessKeys = new Map<string, string>();
  /** Every host whose agents this epic projects. The cloud feed is shared
   * across them, so its state must not be shown only on the transport relay. */
  private originHostIds: ReadonlyArray<string> = [];
  private rejectedRelayHostIds = new Set<string>();
  private unsupportedRelayHostIds = new Set<string>();
  private relayHostId: string | null = null;
  private relayStatus: CommGraphHostStatus = "connecting";
  private cursor: HostCommunicationGraphCloudFeedCursor | null = null;
  private historyBoundary: number | null = null;
  private historyBoundaryInitialized = false;
  private historyCaughtUp = false;
  private availability: CommGraphCloudAvailability = "pending";
  private events: CommGraphEvent[] = [];
  private lastArrival: CommGraphEvent | null = null;
  private handle: CommGraphCloudSubscriptionHandle | null = null;
  private reconnectingFailoverTimer: number | null = null;
  private readonly dataCommitWindowMs: number;
  private dataCommitTimer: number | null = null;
  /** When the snapshot was last published, by any path. */
  private lastCommitAt = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private attached = false;
  private disposed = false;
  private snapshot: CommGraphSnapshot = {
    events: [],
    hosts: [],
    initialHistoryCaughtUp: false,
    lastArrival: null,
  };

  /**
   * `dataCommitWindowMs` is how long rows arriving on the heels of a publish
   * are held before the next one - see `requestDataCommit`. Zero publishes
   * every frame as it is applied.
   */
  constructor(
    epicId: string,
    opener: CommGraphCloudSubscriptionOpener,
    onRowsPruned: (rowKeys: ReadonlySet<string>) => void,
    dataCommitWindowMs: number,
  ) {
    this.epicId = epicId;
    this.opener = opener;
    this.onRowsPruned = onRowsPruned;
    this.dataCommitWindowMs = dataCommitWindowMs;
  }

  setRelayHostIds(hostIds: ReadonlyArray<string>): void {
    if (this.disposed) return;
    const next = Array.from(new Set(hostIds));
    if (sameOrderedHostIds(next, this.relayHostIds)) return;
    this.relayHostIds = next;
    this.retainVerdictsForListedHosts(next);
    if (this.relayHostId !== null && next.includes(this.relayHostId)) {
      this.scheduleReconnectingFailover(this.relayHostId);
      return;
    }
    this.closeCurrent();
    if (this.attached) this.openNextRelay();
    this.commit();
  }

  /**
   * Clears retained dial verdicts when the directory changes the transport
   * identity of a relay without changing its host ID. This lets a host that
   * published late, restarted, or upgraded get another cloud-feed attempt.
   */
  setRelayReadinessKeys(readinessKeys: ReadonlyMap<string, string>): void {
    if (this.disposed) return;
    const changedHostIds = changedReadinessHostIds(
      this.relayReadinessKeys,
      readinessKeys,
    );
    if (changedHostIds.size === 0) return;
    this.relayReadinessKeys = new Map(readinessKeys);
    if (!this.attached) return;
    this.clearVerdictsFor(changedHostIds);
    // A re-enrollment can keep the same host ID while rotating the relay's
    // transport identity. Reopen an active stream as well as retrying failed
    // candidates so it renegotiates with the new key rather than retaining a
    // stale authenticated channel. An unrelated host's directory update must
    // not interrupt a healthy relay.
    if (this.relayHostId !== null && changedHostIds.has(this.relayHostId)) {
      this.closeCurrent();
      this.openNextRelay();
    } else if (this.handle === null) {
      this.openNextRelay();
    }
    if (this.relayHostId !== null) {
      this.scheduleReconnectingFailover(this.relayHostId);
    }
    this.commit();
  }

  /**
   * Installs a relay list and its readiness keys as ONE update, with every
   * dial-affecting side effect deferred until both are installed.
   *
   * The two setters above are each a complete update on their own - they close
   * and reopen synchronously - so pushing the two halves of a single directory
   * change through them in sequence makes the manager act on half-installed
   * state twice: the first call decides against the other half's stale value,
   * and a terminal verdict the opener reports SYNCHRONOUSLY during that open
   * (the replay `openNextRelay` guards below) is then wiped by the second
   * call's readiness sweep, so the relay it just refused becomes a candidate
   * again. Both are artifacts of the split, not decisions anyone made. They
   * stay because the registry's acquire path and the manager suites still push
   * one half at a time.
   *
   * Every verdict edit here therefore happens BEFORE any open, which is what
   * makes a verdict produced during this reconcile survive it.
   */
  reconcileRelays(reconciliation: CommGraphRelayReconciliation): void {
    if (this.disposed) return;
    const nextHostIds = Array.from(new Set(reconciliation.hostIds));
    const hostIdsUnchanged = sameOrderedHostIds(nextHostIds, this.relayHostIds);
    const changedHostIds = changedReadinessHostIds(
      this.relayReadinessKeys,
      reconciliation.readinessKeys,
    );
    // The conjunction of the two setters' own no-op guards. The hook rebuilds
    // both memos by identity on every directory re-emit, and an update that
    // moves neither value is one neither setter would have acted on.
    if (hostIdsUnchanged && changedHostIds.size === 0) return;

    this.relayHostIds = nextHostIds;
    this.relayReadinessKeys = new Map(reconciliation.readinessKeys);
    // Retry the hosts whose transport identity moved, then drop the verdicts
    // of hosts that are no longer candidates at all. Clearing while detached
    // is inert rather than a widening: `attach` discards both sets wholesale.
    this.clearVerdictsFor(changedHostIds);
    this.retainVerdictsForListedHosts(nextHostIds);

    // One decision for the incumbent. Relay preference applies at SELECTION:
    // a healthy relay is not torn down because a higher-priority candidate
    // appeared ahead of it, nor because an unrelated host's readiness moved.
    // Only its OWN transport identity changing, or its removal from the list,
    // reopens - and the reopen then picks up the new order. `openNextRelay`
    // no-ops while a handle is held, so the single call below is the whole
    // decision: reopen after a close, open when nothing is held, keep
    // otherwise.
    const incumbentHostId = this.relayHostId;
    if (
      incumbentHostId !== null &&
      (!nextHostIds.includes(incumbentHostId) ||
        changedHostIds.has(incumbentHostId))
    ) {
      this.closeCurrent();
    }
    this.openNextRelay();

    // An incumbent that has been `reconnecting` with nowhere to fail over arms
    // no deadline, so a newly listed alternative - or one whose `unsupported`
    // verdict the readiness change above just cleared - has to be able to arm
    // the timer that was previously ineligible. The call preserves an
    // already-armed deadline, so a pure reorder never restarts the budget.
    if (this.relayHostId !== null) {
      this.scheduleReconnectingFailover(this.relayHostId);
    }
    this.commit();
  }

  setOriginHostIds(hostIds: ReadonlyArray<string>): void {
    if (this.disposed) return;
    const next = Array.from(new Set(hostIds));
    if (sameOrderedHostIds(next, this.originHostIds)) return;
    this.originHostIds = next;
    this.commit();
  }

  attach(): void {
    if (this.disposed || this.attached) return;
    this.attached = true;
    // Unsupported and failed are verdicts for a single retained dial cycle,
    // not permanent facts about a host. A close/reopen must retry the current
    // set so a restarted or upgraded host can become the cloud relay.
    this.rejectedRelayHostIds.clear();
    this.unsupportedRelayHostIds.clear();
    this.openNextRelay();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.closeCurrent();
    // Retained cloud rows remain readable while authorization is unavailable,
    // but a detached relay must not advertise them as a live feed. This marks
    // retained data as non-live; retries resume only on attach. Feed-health UI
    // gates on isAttached(), so detaching does not claim an active retry.
    this.relayStatus = "reconnecting";
    // A later attach opens a new stream whose first snapshot is backlog learned
    // while this surface was absent. Retain rows/cursor, but start a fresh
    // arrival boundary so that backlog cannot pulse as live activity.
    this.historyBoundary = null;
    this.historyBoundaryInitialized = false;
    this.historyCaughtUp = false;
    this.lastArrival = null;
    this.commit();
  }

  redialHosts(hostIds: ReadonlyArray<string>): void {
    if (
      !this.attached ||
      this.relayHostId === null ||
      !hostIds.includes(this.relayHostId)
    ) {
      return;
    }
    this.closeCurrent();
    this.openNextRelay();
  }

  getAvailability(): CommGraphCloudAvailability {
    return this.availability;
  }

  getSnapshot(): CommGraphSnapshot {
    return this.snapshot;
  }

  /** See `CommGraphSubscriptionManager.isAttached`. */
  isAttached(): boolean {
    return this.attached;
  }

  isInitialHistoryCaughtUp(): boolean {
    return this.historyCaughtUp;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    // `detach` publishes, which also cancels a pending data commit - but only
    // when there was something attached to detach.
    this.clearDataCommitTimer();
    this.listeners.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Retries the hosts whose transport identity moved. Both verdicts are
   * per-dial-cycle judgements about a specific transport, so a host that
   * published late, restarted, upgraded or was re-enrolled gets another turn.
   */
  private clearVerdictsFor(hostIds: ReadonlySet<string>): void {
    for (const hostId of hostIds) {
      this.rejectedRelayHostIds.delete(hostId);
      this.unsupportedRelayHostIds.delete(hostId);
    }
  }

  /** Drops the verdicts of hosts that are no longer candidates at all. */
  private retainVerdictsForListedHosts(hostIds: ReadonlyArray<string>): void {
    this.rejectedRelayHostIds = new Set(
      Array.from(this.rejectedRelayHostIds).filter((hostId) =>
        hostIds.includes(hostId),
      ),
    );
    this.unsupportedRelayHostIds = new Set(
      Array.from(this.unsupportedRelayHostIds).filter((hostId) =>
        hostIds.includes(hostId),
      ),
    );
  }

  private openNextRelay(): void {
    if (!this.attached || this.handle !== null) return;
    const hostId = this.relayHostIds.find(
      (candidate) => !this.rejectedRelayHostIds.has(candidate),
    );
    if (hostId === undefined) {
      if (
        this.relayHostIds.length > 0 &&
        this.relayHostIds.every((candidate) =>
          this.unsupportedRelayHostIds.has(candidate),
        )
      ) {
        this.availability = "unsupported";
      }
      this.commit();
      return;
    }
    this.relayHostId = hostId;
    this.relayStatus = "connecting";
    this.generation += 1;
    const generation = this.generation;
    const isCurrent = (): boolean =>
      !this.disposed &&
      this.relayHostId === hostId &&
      this.generation === generation;
    try {
      const handle = this.opener({
        hostId,
        epicId: this.epicId,
        readSinceCursor: () => this.cursor,
        handlers: {
          onAvailability: () => {
            if (!isCurrent()) return;
            this.applyAvailability();
          },
          onSnapshot: (events, headVersion, frontier) => {
            if (!isCurrent()) return;
            this.apply(events, headVersion, frontier);
          },
          onEvent: (event) => {
            if (!isCurrent()) return;
            this.apply([event], null, null);
          },
          onCaughtUp: (cursor, headVersion) => {
            if (!isCurrent()) return;
            this.applyCaughtUp(cursor, headVersion);
          },
          onStatus: (status) => {
            if (!isCurrent()) return;
            this.applyStatus(hostId, status);
          },
        },
      });
      // A LogicalStream can replay a terminal status while the opener is
      // still returning. That status may synchronously fail over to another
      // relay, whose handle must not be overwritten by this stale one.
      if (isCurrent()) {
        this.handle = handle;
      } else {
        this.closeHandle(handle, hostId);
      }
    } catch (cause) {
      this.relayStatus = "failed";
      // A synchronous dial failure has no handle to emit an `unreachable`
      // status. Reject this candidate ourselves before continuing through the
      // remaining scoped relays; otherwise the unchanged relay set would keep
      // the manager wedged on this null-handle host indefinitely.
      this.rejectedRelayHostIds.add(hostId);
      this.relayHostId = null;
      appLogger.error(
        "[comm-graph] cloud relay dial failed",
        { epicId: this.epicId, hostId },
        cause,
      );
      this.openNextRelay();
      this.commit();
    }
  }

  private applyAvailability(): void {
    if (this.availability !== "available") {
      this.historyBoundary = null;
      this.historyBoundaryInitialized = false;
      this.historyCaughtUp = false;
      this.lastArrival = null;
    }
    this.availability = "available";
    this.commit();
  }

  /** Snapshot and incremental frames share this cursor-aware apply path. */
  private apply(
    wireEvents: ReadonlyArray<HostCommunicationGraphCloudFeedEvent>,
    headVersion: number | null,
    frontier: number | null,
  ): void {
    const prunedRowKeys = new Set<string>();
    if (frontier !== null) {
      this.events = this.events.filter((event) => {
        if ((event.ingestVersion ?? 0) >= frontier) return true;
        prunedRowKeys.add(commGraphEventKey(event));
        return false;
      });
      if (
        this.lastArrival !== null &&
        (this.lastArrival.ingestVersion ?? 0) < frontier
      ) {
        this.lastArrival = null;
      }
      this.onRowsPruned(prunedRowKeys);
    }
    const accepted: CommGraphEvent[] = [];
    for (const wireEvent of wireEvents) {
      if (!this.accept(wireEvent)) continue;
      const row = normalizeCloudEvent(wireEvent);
      this.noteArrival(row);
      accepted.push(row);
    }
    if (headVersion !== null && !this.historyBoundaryInitialized) {
      this.historyBoundary = headVersion;
      this.historyBoundaryInitialized = true;
    }
    if (accepted.length > 0) {
      this.events = this.events.concat(accepted);
      this.events.sort(compareCommGraphEvents);
    }
    // A PRUNE PUBLISHES NOW. `onRowsPruned` has already reset the timeline
    // cursor and the open rows in their stores, synchronously, and those
    // stores render in this same task. Holding the snapshot for the window
    // would render that reset against the rows it was reset FOR, a live graph
    // still drawing the pruned rows until the timer fired. A frontier moves
    // rarely, so publishing it at once costs the window nothing.
    if (prunedRowKeys.size > 0) {
      this.commit();
      return;
    }
    if (accepted.length > 0 || headVersion !== null) {
      this.requestDataCommit();
    }
  }

  private accept(event: HostCommunicationGraphCloudFeedEvent): boolean {
    if (this.cursor !== null) {
      if (event.ingestVersion < this.cursor.ingestVersion) return false;
      if (
        event.ingestVersion === this.cursor.ingestVersion &&
        event.eventId <= this.cursor.eventId
      ) {
        return false;
      }
    }
    this.cursor = {
      ingestVersion: event.ingestVersion,
      eventId: event.eventId,
    };
    return true;
  }

  private applyCaughtUp(
    cursor: HostCommunicationGraphCloudFeedCursor | null,
    headVersion: number,
  ): void {
    if (cursor !== null && isCursorAfter(cursor, this.cursor)) {
      this.cursor = cursor;
    }
    const boundary = this.historyBoundary;
    if (this.historyBoundaryInitialized && headVersion >= (boundary ?? 0)) {
      this.historyCaughtUp = true;
    }
    this.commit();
  }

  private noteArrival(row: CommGraphEvent): void {
    if (!this.historyBoundaryInitialized) return;
    if (row.historicalUpload === true) return;
    if (
      this.historyBoundary !== null &&
      (row.ingestVersion ?? 0) <= this.historyBoundary
    ) {
      return;
    }
    if (
      this.lastArrival !== null &&
      compareCommGraphEvents(row, this.lastArrival) <= 0
    ) {
      return;
    }
    this.lastArrival = row;
  }

  private applyStatus(hostId: string, status: CommGraphHostStatus): void {
    // THE STREAM REPORTS `live` AHEAD OF EVERY FRAME IT DELIVERS, so a status
    // that publishes unconditionally publishes once per frame and the data
    // path's coalescing coalesces nothing. A status that is already the
    // published one is not news.
    //
    // Compared against what was PUBLISHED, not only against the field: opening
    // a relay sets the field to `connecting` without publishing, so the first
    // `connecting` the stream reports matches the field and is still the first
    // anyone downstream hears of this relay.
    if (status === this.relayStatus && this.publishedStatusIs(status)) return;
    this.relayStatus = status;
    if (status !== "reconnecting") this.clearReconnectingFailover();
    if (status === "unsupported" || status === "unreachable") {
      this.rejectedRelayHostIds.add(hostId);
      if (status === "unsupported") this.unsupportedRelayHostIds.add(hostId);
      this.closeCurrent();
      this.openNextRelay();
      return;
    }
    if (status === "reconnecting") {
      this.scheduleReconnectingFailover(hostId);
    }
    this.commit();
  }

  private scheduleReconnectingFailover(hostId: string): void {
    const hasUntriedAlternative = this.relayHostIds.some(
      (candidate) =>
        candidate !== hostId && !this.rejectedRelayHostIds.has(candidate),
    );
    const hasRetryableRejectedAlternative = this.relayHostIds.some(
      (candidate) =>
        candidate !== hostId &&
        this.rejectedRelayHostIds.has(candidate) &&
        !this.unsupportedRelayHostIds.has(candidate),
    );
    if (
      this.relayStatus !== "reconnecting" ||
      this.reconnectingFailoverTimer !== null ||
      (!hasUntriedAlternative && !hasRetryableRejectedAlternative)
    ) {
      return;
    }
    this.reconnectingFailoverTimer = window.setTimeout(() => {
      this.reconnectingFailoverTimer = null;
      if (
        !this.attached ||
        this.disposed ||
        this.relayHostId !== hostId ||
        this.relayStatus !== "reconnecting"
      ) {
        return;
      }
      this.rejectedRelayHostIds.add(hostId);
      this.closeCurrent();
      // Once every candidate in this dial cycle has timed out, begin another
      // bounded cycle. Earlier reconnecting/unreachable relays may have
      // recovered while the later candidates were being tried; retaining all
      // rejection marks would otherwise leave the cloud-authoritative graph
      // stale forever. An explicit `unsupported` verdict remains sticky for
      // this attachment and is never retried by the timeout cycle.
      if (
        this.relayHostIds.every((candidate) =>
          this.rejectedRelayHostIds.has(candidate),
        )
      ) {
        this.rejectedRelayHostIds = new Set(this.unsupportedRelayHostIds);
      }
      this.openNextRelay();
      this.commit();
    }, RECONNECTING_RELAY_FAILOVER_MS);
  }

  private clearReconnectingFailover(): void {
    if (this.reconnectingFailoverTimer === null) return;
    window.clearTimeout(this.reconnectingFailoverTimer);
    this.reconnectingFailoverTimer = null;
  }

  private closeCurrent(): void {
    this.clearReconnectingFailover();
    this.generation += 1;
    const handle = this.handle;
    this.handle = null;
    this.relayHostId = null;
    if (handle === null) return;
    this.closeHandle(handle, null);
  }

  private closeHandle(
    handle: CommGraphCloudSubscriptionHandle,
    hostId: string | null,
  ): void {
    try {
      handle.close();
    } catch (cause) {
      appLogger.error(
        "[comm-graph] cloud relay close failed",
        { epicId: this.epicId, hostId },
        cause,
      );
    }
  }

  /** The hosts the feed's status is reported on - see `originHostIds`. */
  private statusHostIds(): ReadonlyArray<string> {
    if (this.originHostIds.length === 0 && this.relayHostId !== null) {
      return [this.relayHostId];
    }
    return this.originHostIds;
  }

  /** Whether the published snapshot already reports `status` on these hosts. */
  private publishedStatusIs(status: CommGraphHostStatus): boolean {
    const expected = this.statusHostIds();
    const published = this.snapshot.hosts;
    return (
      published.length === expected.length &&
      published.every(
        (host, index) =>
          host.hostId === expected[index] && host.status === status,
      )
    );
  }

  /**
   * Publishes applied rows, at most once per window.
   *
   * ROWS ARE APPLIED AS THEY ARRIVE AND PUBLISHED IN BATCHES. An epic's history
   * arrives as hundreds of frames a second, each in a task of its own, and a
   * publish is a render of everything that reads the feed. Publishing per
   * frame made a few thousand rows cost a few thousand renders of a graph
   * that grew by one row each time.
   *
   * LEADING EDGE, THEN A TRAILING ONE. A frame that arrives after a quiet
   * window publishes immediately, so a lone live row lands as it always did.
   * Frames that follow inside the window are applied and wait for one timer,
   * which publishes all of them together. A burst of any size is therefore two
   * publishes, and what is published is always the merged log in order.
   *
   * ONLY THIS PATH WAITS. Status, availability, the relay directory, caught-up,
   * detach and a frame that prunes rows publish as they happen (`commit`):
   * they are rare, and what reads them - the feed-health dot, the resume
   * cursor, the timeline cursor a prune resets - reads them in the same tick.
   * Such a publish carries every row applied so far, so it also retires the
   * timer.
   *
   * WHAT A BATCH COSTS: `lastArrival` holds the newest arrival only, so live
   * rows that land inside one window pulse once between them, where each used
   * to pulse on its own. That is accepted. Letting an arrival skip the window
   * would bring back a publish per row for the one case that most needs
   * batching, because a backlog that overflows the first snapshot is delivered
   * as arrivals.
   */
  private requestDataCommit(): void {
    if (this.disposed) return;
    const sinceLastCommit = Date.now() - this.lastCommitAt;
    // A wall clock can be set back. A negative interval is not "inside the
    // window", and reading it as one would arm a timer for longer than the
    // window is.
    if (sinceLastCommit < 0 || sinceLastCommit >= this.dataCommitWindowMs) {
      this.commit();
      return;
    }
    if (this.dataCommitTimer !== null) return;
    this.dataCommitTimer = window.setTimeout(() => {
      this.dataCommitTimer = null;
      this.commit();
    }, this.dataCommitWindowMs - sinceLastCommit);
  }

  private clearDataCommitTimer(): void {
    if (this.dataCommitTimer === null) return;
    window.clearTimeout(this.dataCommitTimer);
    this.dataCommitTimer = null;
  }

  /** Publishes now. Everything but `apply` comes here directly. */
  private commit(): void {
    if (this.disposed) return;
    this.clearDataCommitTimer();
    this.lastCommitAt = Date.now();
    this.snapshot = {
      events: this.events,
      hosts: this.statusHostIds().map((hostId) => ({
        hostId,
        status: this.relayStatus,
        cursor: this.cursor?.ingestVersion ?? null,
        snapshotBoundary: this.historyBoundaryInitialized
          ? { highestId: this.historyBoundary }
          : null,
      })),
      initialHistoryCaughtUp: this.historyCaughtUp,
      lastArrival: this.lastArrival,
    };
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/**
 * ORDERED identity, deliberately not set identity: a pure reorder IS a change
 * to these callers, because the list is a preference order and its head is the
 * next candidate `openNextRelay` picks. Comparing as sets would let a reorder
 * take an early return and never reach the incumbent decision.
 */
function sameOrderedHostIds(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((hostId, index) => hostId === right[index])
  );
}

/**
 * The hosts whose readiness key moved, taken over the UNION of both maps - so
 * a host that appears and one that disappears each count as changed, not just
 * the ones present in both.
 */
function changedReadinessHostIds(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const hostId of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(hostId) !== next.get(hostId)) changed.add(hostId);
  }
  return changed;
}

function normalizeCloudEvent(
  event: HostCommunicationGraphCloudFeedEvent,
): CommGraphEvent {
  return {
    id: event.originSequence,
    eventId: event.eventId,
    hostId: event.originHostId,
    ingestVersion: event.ingestVersion,
    historicalUpload: event.historicalUpload,
    kind: event.kind,
    timestamp: event.capturedAt,
    senderAgentId: event.senderAgentId,
    receiverAgentId: event.receiverAgentId,
    responseId: event.responseId,
    inReplyTo: event.inReplyTo,
    expectReply: event.expectReply,
    messageText: event.messageText,
    noticeReason: event.noticeReason,
    originKind: event.originKind,
    originChatId: event.originChatId,
    originRefId: event.originRefId,
    peerEpicId: event.peerEpicId,
  };
}

function isCursorAfter(
  candidate: HostCommunicationGraphCloudFeedCursor,
  current: HostCommunicationGraphCloudFeedCursor | null,
): boolean {
  return (
    current === null ||
    candidate.ingestVersion > current.ingestVersion ||
    (candidate.ingestVersion === current.ingestVersion &&
      candidate.eventId > current.eventId)
  );
}
