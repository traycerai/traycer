/**
 * Per-host fan-in for `epic.communicationGraph.subscribe@1.0`.
 *
 * A multi-host epic has ONE graph but N event logs: A2A delivery is host-local
 * (cross-host sends are rejected at the broker), so each host holds a disjoint
 * slice of the conversation. The tile therefore opens one subscription per host
 * its agents live on and merges the frames client-side.
 *
 * This module owns that fan-in as a plain (non-React) manager so a tile can
 * open an unbounded number of subscriptions - a hook-per-host is impossible -
 * and so the merge logic is testable against a faked stream boundary.
 *
 * Lifecycle is split in two on purpose:
 *
 *   - `setHostIds` declares WHICH hosts should be covered (data-driven, from
 *     the epic's agent projection).
 *   - `attach` / `detach` declare WHETHER sockets should be open (React effect
 *     driven). `detach` keeps the accumulated events and per-host cursors, so a
 *     StrictMode mount / unmount / remount re-attaches and resumes from the
 *     cursor instead of re-pulling every snapshot.
 */
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";
import { appLogger } from "@/lib/logger";
import {
  compareCommGraphEvents,
  mergeCommGraphEvents,
  type CommGraphEvent,
  type CommGraphHostSnapshotBoundary,
  type CommGraphHostState,
  type CommGraphHostStatus,
  type CommGraphSnapshot,
} from "@/lib/comm-graph/comm-graph-events";

/**
 * FRAME KIND IS TRANSPORT BATCHING, NOT MEANING. `snapshot` is a BOUNDED
 * initial batch, not a completeness claim: rows that predate the subscription
 * legitimately arrive as `event` frames (snapshot overflow past the host's
 * ceiling, and reconnect gap-fills). Nothing downstream may therefore treat an
 * `event` frame as "something just happened" - newness is derived from row
 * timestamps against state we already hold, which is also what makes the same
 * code correct for the timeline's time cursor. Both handlers below feed the
 * identical apply path for exactly this reason.
 */
export interface CommGraphSubscriptionHandlers {
  readonly onSnapshot: (
    events: ReadonlyArray<EpicCommunicationGraphEvent>,
    /**
     * The host log's head id at handoff (`snapshot.headId` on the wire), null
     * for an empty log. THE arrival boundary - not the snapshot's last row,
     * which a bounded snapshot legally undershoots.
     */
    headId: number | null,
  ) => void;
  readonly onEvent: (event: EpicCommunicationGraphEvent) => void;
  readonly onStatus: (status: CommGraphHostStatus) => void;
}

export interface CommGraphSubscriptionRequest {
  readonly hostId: string;
  readonly epicId: string;
  /**
   * Highest applied row id for THIS host, or `null` on a first open.
   *
   * Required-and-nullable on the wire: omitting the key fails the open-request
   * parse, so "start from the beginning" must be sent explicitly as `null`.
   */
  readonly sinceCursor: number | null;
  readonly handlers: CommGraphSubscriptionHandlers;
}

export interface CommGraphSubscriptionHandle {
  readonly close: () => void;
}

export type CommGraphSubscriptionOpener = (
  request: CommGraphSubscriptionRequest,
) => CommGraphSubscriptionHandle;

/**
 * Failed dials after which a host is STYLED unreachable.
 *
 * Purely a reporting threshold - the session keeps retrying underneath on its
 * own backoff, and a later `live` clears it. Without it, a host with no
 * dialable endpoint (removed, offline, never provisioned) cycles
 * connecting → reconnecting forever and its agents would read "Reconnecting…"
 * indefinitely, never reaching the muted unreachable state the graph promises.
 * Two, not one, so an ordinary transient blip does not immediately mute a
 * healthy host.
 */
const UNREACHABLE_AFTER_FAILED_DIALS = 2;

/**
 * Attempts a CONTAINED redial makes before leaving the host `failed`.
 *
 * Building a transport can throw synchronously (wiring bearer-rotation, wake and
 * endpoint-change listeners), and the redial that replaces an orphaned socket
 * runs inside a React cleanup where there is no caller to hand the error to. So
 * it is retried a few times and then given up on honestly - a persistently
 * broken transport must degrade, not loop.
 */
const REDIAL_MAX_ATTEMPTS = 3;
const REDIAL_RETRY_BASE_MS = 200;

interface HostEntry {
  readonly hostId: string;
  /** Raw status from the session, before the unreachable-after-N reporting rule. */
  status: CommGraphHostStatus;
  /** Highest applied row id. Also the resume cursor. Survives `detach`. */
  cursor: number | null;
  /**
   * This host's initialization line - see `CommGraphHostSnapshotBoundary`. Set
   * once, at the first snapshot handoff, and survives `detach` along with the
   * cursor: a StrictMode remount resumes the same subscription rather than
   * re-initializing it, and re-seeding here would silently reclassify rows the
   * user has already been shown.
   */
  snapshotBoundary: CommGraphHostSnapshotBoundary | null;
  /** Cursor the CURRENT subscription was opened with. */
  openedCursor: number | null;
  /** Consecutive dial failures since the last time this host was `live`. */
  failedDials: number;
  /**
   * Consecutive CONTAINED redials that threw while BUILDING the transport.
   * Distinct from `failedDials`, which counts sockets that opened and then fell
   * back to reconnecting.
   */
  dialThrows: number;
  /** Pending bounded redial retry handle, if one is scheduled. */
  retryTimer: number | null;
  events: CommGraphEvent[];
  handle: CommGraphSubscriptionHandle | null;
  /**
   * Bumped on every open / close. Handlers carry the generation they were
   * opened under, so a frame that arrives from a subscription we already
   * replaced (or detached) is ignored rather than applied out of band.
   */
  generation: number;
}

/**
 * What the canvas should show for a host, which is not always the raw socket
 * status: a host that has failed to dial repeatedly is reported as
 * `unreachable` even while its session is technically mid-reconnect.
 */
function reportedStatus(entry: HostEntry): CommGraphHostStatus {
  // A transport that could not be BUILT reports as such, and keeps reporting it:
  // there is no socket underneath to produce a lifecycle status, so nothing
  // would ever overwrite this until a redial succeeds.
  if (entry.status === "failed") return "failed";
  if (entry.failedDials < UNREACHABLE_AFTER_FAILED_DIALS) return entry.status;
  if (entry.status === "reconnecting" || entry.status === "connecting") {
    return "unreachable";
  }
  return entry.status;
}

export class CommGraphSubscriptionManager {
  private readonly epicId: string;
  private readonly opener: CommGraphSubscriptionOpener;
  private readonly hosts = new Map<string, HostEntry>();
  private readonly listeners = new Set<() => void>();
  private desiredHostIds: ReadonlyArray<string> = [];
  /**
   * Newest row seen above its own host's boundary. Sticky: this layer decides
   * WHAT arrived, never for how long anything should look like it just did.
   */
  private lastArrival: CommGraphEvent | null = null;
  private snapshot: CommGraphSnapshot = {
    events: [],
    hosts: [],
    lastArrival: null,
  };
  private merged: ReadonlyArray<CommGraphEvent> = [];
  private attached = false;
  private disposed = false;

  constructor(epicId: string, opener: CommGraphSubscriptionOpener) {
    this.epicId = epicId;
    this.opener = opener;
  }

  /**
   * Declares the hosts the epic's agents currently live on. Idempotent, so it
   * can be driven straight from a render-derived list.
   *
   * A host that leaves the set has its events dropped along with its
   * subscription - it no longer contributes nodes either, so keeping its edges
   * would draw them into nothing.
   */
  setHostIds(hostIds: ReadonlyArray<string>): void {
    if (this.disposed) return;
    this.desiredHostIds = [...hostIds];
    this.reconcile();
  }

  /** Opens sockets for the declared hosts. Safe to call when already attached. */
  attach(): void {
    if (this.disposed || this.attached) return;
    this.attached = true;
    this.reconcile();
  }

  /**
   * Closes every socket but keeps the accumulated events and cursors, so a
   * re-attach resumes from the highest seen id per host.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const entry of this.hosts.values()) {
      // A pending redial retry must not outlive the attachment it was retrying
      // for - it would reopen a socket nobody is watching.
      this.clearRetryTimer(entry);
      this.closeEntry(entry);
    }
  }

  getSnapshot(): CommGraphSnapshot {
    return this.snapshot;
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
    this.hosts.clear();
    this.listeners.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Closes and reopens the named hosts' transports, resuming each from its own
   * cursor.
   *
   * Exists for ORPHANED transports: a socket is opened through one surface's
   * opener, and that opener reads its transport dependencies through a ref only
   * that surface keeps refreshing. When the surface goes away while another is
   * still watching, the socket it opened is left reading frozen state - so it
   * has to be re-dialed through an opener that is still live. Reusing the same
   * open path makes it lossless by construction: `sinceCursor` is the host's
   * applied cursor, and `accept` drops anything re-delivered at or below it, so
   * the swap can neither lose a row nor duplicate one.
   *
   * A host with no open transport (never dialed, or the manager is detached) is
   * skipped - there is nothing orphaned to replace.
   *
   * NEVER THROWS. This runs inside a React effect cleanup, where an escaping
   * error reaches the renderer's error boundary and the surface that would have
   * retried is already gone. Building a transport CAN throw synchronously
   * (`openDurableStreamTransport` rethrows if wiring its bearer-rotation, wake
   * or endpoint-change listeners fails), so each host is contained
   * individually: logged, marked `failed`, and retried on a bounded schedule.
   */
  redialHosts(hostIds: ReadonlyArray<string>): void {
    if (this.disposed || !this.attached) return;
    for (const hostId of hostIds) {
      const entry = this.hosts.get(hostId);
      if (entry === undefined || entry.handle === null) continue;
      this.replaceTransport(entry);
    }
  }

  private reconcile(): void {
    const desired = new Set(this.desiredHostIds);
    let changed = false;
    for (const [hostId, entry] of Array.from(this.hosts.entries())) {
      if (desired.has(hostId)) continue;
      this.clearRetryTimer(entry);
      this.closeEntry(entry);
      this.hosts.delete(hostId);
      // The departing host's rows leave with it, so an arrival that pointed at
      // one must not survive to be pulsed against a node that is also gone.
      if (this.lastArrival?.hostId === hostId) this.lastArrival = null;
      changed = true;
    }
    for (const hostId of desired) {
      const existing = this.hosts.get(hostId);
      if (existing === undefined) {
        this.hosts.set(hostId, {
          hostId,
          status: "connecting",
          cursor: null,
          snapshotBoundary: null,
          openedCursor: null,
          failedDials: 0,
          dialThrows: 0,
          retryTimer: null,
          events: [],
          handle: null,
          generation: 0,
        });
        changed = true;
      }
      const entry = this.hosts.get(hostId);
      if (entry === undefined) continue;
      if (this.attached && entry.handle === null) {
        // OPPORTUNISTIC RECONCILE, CONTAINED. A host left with no handle by an
        // earlier dial failure - including one that exhausted its retry cap - is
        // picked up here, so the next host-set change or attach recovers it.
        //
        // Contained on EVERY path, not just the cleanup one. There is no caller
        // that can be relied on to own a dial failure: `setHostIds` is called
        // from a plain effect as well as from the transactional acquire, so an
        // escaping throw there would cancel this host's bounded recovery AND
        // abandon every host after it in this loop. Containing per host means one
        // broken transport can never block another's dial - it degrades to
        // `failed` + retry and the loop carries on.
        this.openContained(entry, true);
        changed = true;
      }
    }
    if (!changed) return;
    // A departed host's events leave with it, so the merged array is rebuilt
    // rather than just re-published.
    this.remerge();
    this.publish();
  }

  /** Close-then-reopen one host. Both halves are nonthrowing by construction. */
  private replaceTransport(entry: HostEntry): void {
    this.closeEntry(entry);
    this.openContained(entry, true);
    this.publish();
  }

  /**
   * Open one host's transport, degrading a throw to `failed` + a bounded retry
   * instead of propagating it. The ONLY way this manager dials.
   *
   * `resetBudget` distinguishes a fresh EXTERNAL trigger (a host-set change, an
   * attach, a claim releasing) from a continuation of the automatic retry chain.
   * The cap exists to stop that chain from looping forever, not to permanently
   * blacklist a host - so an external trigger starts a new budget and a timer
   * firing does not.
   */
  private openContained(entry: HostEntry, resetBudget: boolean): boolean {
    this.clearRetryTimer(entry);
    if (resetBudget) entry.dialThrows = 0;
    try {
      this.open(entry);
      this.clearDialFailure(entry);
      return true;
    } catch (cause) {
      this.recordDialFailure(entry, cause);
      return false;
    }
  }

  private clearDialFailure(entry: HostEntry): void {
    entry.dialThrows = 0;
    // The new socket reports its own lifecycle from here; until it does,
    // `connecting` is the honest reading.
    if (entry.status === "failed") entry.status = "connecting";
  }

  private recordDialFailure(entry: HostEntry, cause: unknown): void {
    entry.dialThrows += 1;
    entry.status = "failed";
    entry.handle = null;
    appLogger.error(
      "[comm-graph] transport dial failed",
      { epicId: this.epicId, hostId: entry.hostId, attempt: entry.dialThrows },
      cause,
    );
    this.scheduleRedialRetry(entry);
  }

  /**
   * Bounded backoff retry for a contained failure.
   *
   * Capped rather than endless: a transport that cannot be constructed is
   * usually not going to become constructible by trying harder, and a host stuck
   * in a redial loop is worse than one that reads `failed`. Exhausting the cap
   * is not the end of the story - `reconcile` reopens any attached host with no
   * handle, so the next `setHostIds` or `attach` (i.e. the next surface to
   * mount) picks it up opportunistically.
   */
  private scheduleRedialRetry(entry: HostEntry): void {
    if (entry.retryTimer !== null) return;
    if (entry.dialThrows >= REDIAL_MAX_ATTEMPTS) return;
    const delay = REDIAL_RETRY_BASE_MS * 2 ** (entry.dialThrows - 1);
    entry.retryTimer = window.setTimeout(() => {
      entry.retryTimer = null;
      if (this.disposed || !this.attached) return;
      // The entry may have been replaced (host left and came back) or already
      // reopened by a reconcile that beat the timer.
      if (this.hosts.get(entry.hostId) !== entry) return;
      if (entry.handle !== null) return;
      // Continuation of the automatic chain, so the budget is NOT reset - this
      // is the loop the cap is there to bound.
      this.openContained(entry, false);
      this.publish();
    }, delay);
  }

  private clearRetryTimer(entry: HostEntry): void {
    if (entry.retryTimer === null) return;
    window.clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }

  /**
   * Closes this host's transport and retires its generation. NEVER THROWS.
   *
   * `close()` disposes listener subscriptions, any of which can throw, and every
   * caller here is either a teardown loop (detach, host removal) or a swap -
   * places where one broken disposer must not abandon the hosts after it, escape
   * a React cleanup, or skip the registry's ownership and MRU bookkeeping.
   * Containing it HERE rather than at each call site is what makes that
   * checkable: there is no uncontained variant to reach for.
   *
   * The handle is dropped and the generation bumped BEFORE the close, so a
   * throwing disposer still leaves the entry in a correct "no transport" state
   * and any late frame from the old socket is still ignored.
   */
  private closeEntry(entry: HostEntry): void {
    if (entry.handle === null) return;
    entry.generation += 1;
    const handle = entry.handle;
    entry.handle = null;
    try {
      handle.close();
    } catch (cause) {
      appLogger.error(
        "[comm-graph] transport close failed",
        { epicId: this.epicId, hostId: entry.hostId },
        cause,
      );
    }
  }

  private open(entry: HostEntry): void {
    entry.generation += 1;
    const generation = entry.generation;
    entry.openedCursor = entry.cursor;
    const isCurrent = (): boolean =>
      !this.disposed &&
      this.hosts.get(entry.hostId) === entry &&
      entry.generation === generation;
    entry.handle = this.opener({
      hostId: entry.hostId,
      epicId: this.epicId,
      sinceCursor: entry.cursor,
      handlers: {
        onSnapshot: (events, headId) => {
          if (!isCurrent()) return;
          this.applySnapshot(entry, events, headId);
        },
        onEvent: (event) => {
          if (!isCurrent()) return;
          this.applyEvent(entry, event);
        },
        onStatus: (status) => {
          if (!isCurrent()) return;
          this.applyStatus(entry, status);
        },
      },
    });
  }

  private applySnapshot(
    entry: HostEntry,
    events: ReadonlyArray<EpicCommunicationGraphEvent>,
    headId: number | null,
  ): void {
    const accepted = events.flatMap((event) => {
      if (!this.accept(entry, event)) return [];
      const row: CommGraphEvent = { ...event, hostId: entry.hostId };
      // On the FIRST snapshot the boundary is still unset, so none of these
      // count - which is the point. On a reconnect gap snapshot the boundary is
      // already drawn and its rows appeared while we were away, so they do.
      this.noteArrival(entry, row);
      return [row];
    });
    // The boundary is the HOST'S head at handoff, from the wire - not the
    // snapshot's own last row. The snapshot is bounded, so pre-existing
    // backlog past its bound legally arrives as `event` frames; only the
    // head separates that overflow (history) from genuinely-new rows. An
    // EMPTY snapshot still draws a boundary - a fresh epic has no history,
    // and skipping it would leave this host permanently uninitialized.
    const initialized = this.markSnapshotBoundary(entry, headId);
    if (accepted.length === 0) {
      if (initialized) this.publish();
      return;
    }
    entry.events = entry.events.concat(accepted);
    this.remerge();
    this.publish();
  }

  /**
   * Draws this host's initialization line, ONCE. A later snapshot on the same
   * entry is a reconnect gap-fill, and the rows in it appeared while we were
   * disconnected - they are arrivals, so the line must not move past them.
   */
  private markSnapshotBoundary(
    entry: HostEntry,
    headId: number | null,
  ): boolean {
    if (entry.snapshotBoundary !== null) return false;
    const boundary: CommGraphHostSnapshotBoundary = { highestId: headId };
    entry.snapshotBoundary = boundary;
    return true;
  }

  /**
   * Records a row as the newest ARRIVAL when it sits above its own host's
   * boundary.
   *
   * Two comparisons, deliberately different: the boundary test uses the row's
   * id against ITS OWN host's line (ids are monotonic per host and meaningless
   * across hosts), while "is this newer than the last arrival" uses the merged
   * array's total order, because that one genuinely spans hosts.
   *
   * Frame kind never enters into it. A row is an arrival because of where it
   * sits relative to a line we drew, not because of which frame carried it.
   */
  private noteArrival(entry: HostEntry, row: CommGraphEvent): void {
    const boundary = entry.snapshotBoundary;
    if (boundary === null) return;
    // A boundary drawn on an EMPTY snapshot has no floor: this host had no
    // history, so everything it ever produces is new.
    if (boundary.highestId !== null && row.id <= boundary.highestId) return;
    if (
      this.lastArrival !== null &&
      compareCommGraphEvents(row, this.lastArrival) <= 0
    ) {
      return;
    }
    this.lastArrival = row;
  }

  private applyEvent(
    entry: HostEntry,
    event: EpicCommunicationGraphEvent,
  ): void {
    if (!this.accept(entry, event)) return;
    const next: CommGraphEvent = { ...event, hostId: entry.hostId };
    this.noteArrival(entry, next);
    entry.events.push(next);
    // An `event` frame usually carries the newest row, so the append is O(1).
    // It is NOT guaranteed to: snapshot overflow and reconnect gap-fills also
    // arrive as `event` frames and can be older than what we hold, and
    // cross-host clock skew can interleave. Those fall through to a re-merge
    // rather than being appended out of order.
    const last = this.merged.at(-1);
    if (last === undefined || compareCommGraphEvents(last, next) <= 0) {
      this.merged = this.merged.concat([next]);
    } else {
      this.remerge();
    }
    this.publish();
  }

  /**
   * Resume-gap guard, keyed ONLY on the host's own monotonic row id.
   *
   * This is NOT content dedup - distinct row ids always both pass, whatever
   * their content. It exists because a dropped socket
   * auto-re-subscribes with the cursor the session was OPENED with, so a
   * snapshot can legitimately re-deliver rows this client already applied.
   * Rows are immutable, so skipping an already-applied id loses nothing.
   */
  private accept(
    entry: HostEntry,
    event: EpicCommunicationGraphEvent,
  ): boolean {
    if (entry.cursor !== null && event.id <= entry.cursor) return false;
    entry.cursor = event.id;
    return true;
  }

  private applyStatus(entry: HostEntry, status: CommGraphHostStatus): void {
    const before = reportedStatus(entry);
    entry.status = status;
    // A dial that reached `open` proves the host is there; anything that falls
    // back to `reconnecting` is a failed dial. A host with no dialable endpoint
    // only ever produces the latter, which is what eventually mutes it.
    if (status === "live") entry.failedDials = 0;
    if (status === "reconnecting") entry.failedDials += 1;
    // A drop after we have already applied rows must resume from the highest
    // seen id rather than re-pull the whole log, so re-open the subscription
    // with the advanced cursor. Bounded by construction: the reopen resets
    // `openedCursor` BEFORE it can throw, so a host that stays down (no new
    // rows, cursor frozen) gets exactly one extra dial per outage and then falls
    // back to the session's own backoff - including when this dial fails.
    //
    // Contained like every other dial: this runs inside the STREAM STATUS
    // CALLBACK, so an escaping throw would surface from the socket's own event
    // handling, leaving the host with no transport, no `failed` publication and
    // nothing scheduled to retry it. A resume is an external trigger, so it
    // starts a fresh retry budget.
    if (status === "reconnecting" && entry.cursor !== entry.openedCursor) {
      this.closeEntry(entry);
      this.openContained(entry, true);
    }
    if (reportedStatus(entry) !== before) this.publish();
  }

  private remerge(): void {
    this.merged = mergeCommGraphEvents(
      Array.from(this.hosts.values(), (entry) => entry.events),
    );
  }

  private publish(): void {
    if (this.disposed) return;
    const hosts: ReadonlyArray<CommGraphHostState> = Array.from(
      this.hosts.values(),
      (entry) => ({
        hostId: entry.hostId,
        status: reportedStatus(entry),
        cursor: entry.cursor,
        snapshotBoundary: entry.snapshotBoundary,
      }),
    );
    this.snapshot = {
      events: this.merged,
      hosts,
      lastArrival: this.lastArrival,
    };
    for (const listener of Array.from(this.listeners)) listener();
  }
}
