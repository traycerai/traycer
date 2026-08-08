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
  "pending" | "available" | "unsupported";

const RECONNECTING_RELAY_FAILOVER_MS = 15_000;

export function selectCommGraphAuthoritativeSnapshot(
  availability: CommGraphCloudAvailability,
  cloud: CommGraphSnapshot,
  local: CommGraphSnapshot,
): CommGraphSnapshot {
  return availability === "available" ? cloud : local;
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
  private generation = 0;
  private attached = false;
  private disposed = false;
  private snapshot: CommGraphSnapshot = {
    events: [],
    hosts: [],
    lastArrival: null,
  };

  constructor(
    epicId: string,
    opener: CommGraphCloudSubscriptionOpener,
    onRowsPruned: (rowKeys: ReadonlySet<string>) => void,
  ) {
    this.epicId = epicId;
    this.opener = opener;
    this.onRowsPruned = onRowsPruned;
  }

  setRelayHostIds(hostIds: ReadonlyArray<string>): void {
    if (this.disposed) return;
    const next = Array.from(new Set(hostIds));
    if (
      next.length === this.relayHostIds.length &&
      next.every((hostId, index) => hostId === this.relayHostIds[index])
    ) {
      return;
    }
    this.relayHostIds = next;
    this.rejectedRelayHostIds = new Set(
      Array.from(this.rejectedRelayHostIds).filter((hostId) =>
        next.includes(hostId),
      ),
    );
    this.unsupportedRelayHostIds = new Set(
      Array.from(this.unsupportedRelayHostIds).filter((hostId) =>
        next.includes(hostId),
      ),
    );
    if (this.relayHostId !== null && next.includes(this.relayHostId)) {
      this.scheduleReconnectingFailover(this.relayHostId);
      return;
    }
    this.closeCurrent();
    if (this.attached) this.openNextRelay();
    this.publish();
  }

  /**
   * Clears retained dial verdicts when the directory changes the transport
   * identity of a relay without changing its host ID. This lets a host that
   * published late, restarted, or upgraded get another cloud-feed attempt.
   */
  setRelayReadinessKeys(readinessKeys: ReadonlyMap<string, string>): void {
    if (this.disposed) return;
    const changedHostIds = new Set<string>();
    for (const hostId of new Set([
      ...this.relayReadinessKeys.keys(),
      ...readinessKeys.keys(),
    ])) {
      if (this.relayReadinessKeys.get(hostId) !== readinessKeys.get(hostId)) {
        changedHostIds.add(hostId);
      }
    }
    if (changedHostIds.size === 0) return;
    this.relayReadinessKeys = new Map(readinessKeys);
    if (!this.attached) return;
    for (const hostId of changedHostIds) {
      this.rejectedRelayHostIds.delete(hostId);
      this.unsupportedRelayHostIds.delete(hostId);
    }
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
    this.publish();
  }

  setOriginHostIds(hostIds: ReadonlyArray<string>): void {
    if (this.disposed) return;
    const next = Array.from(new Set(hostIds));
    if (
      next.length === this.originHostIds.length &&
      next.every((hostId, index) => hostId === this.originHostIds[index])
    ) {
      return;
    }
    this.originHostIds = next;
    this.publish();
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
    // A later attach opens a new stream whose first snapshot is backlog learned
    // while this surface was absent. Retain rows/cursor, but start a fresh
    // arrival boundary so that backlog cannot pulse as live activity.
    this.historyBoundary = null;
    this.historyBoundaryInitialized = false;
    this.historyCaughtUp = false;
    this.lastArrival = null;
    this.publish();
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
    this.listeners.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
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
      this.publish();
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
      this.publish();
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
    this.publish();
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
    if (accepted.length > 0 || headVersion !== null || prunedRowKeys.size > 0) {
      this.publish();
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
    this.publish();
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
    this.publish();
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
      this.publish();
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

  private publish(): void {
    if (this.disposed) return;
    let statusHostIds = this.originHostIds;
    if (statusHostIds.length === 0 && this.relayHostId !== null) {
      statusHostIds = [this.relayHostId];
    }
    this.snapshot = {
      events: this.events,
      hosts: statusHostIds.map((hostId) => ({
        hostId,
        status: this.relayStatus,
        cursor: this.cursor?.ingestVersion ?? null,
        snapshotBoundary: this.historyBoundaryInitialized
          ? { highestId: this.historyBoundary }
          : null,
      })),
      lastArrival: this.lastArrival,
    };
    for (const listener of Array.from(this.listeners)) listener();
  }
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
