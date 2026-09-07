import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  createSessionRegistry,
  type SessionRegistry,
  type SessionDisposeCause,
} from "@traycer-clients/shared/replica-runtime";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { appLogger } from "@/lib/logger";
import { useSyncExternalStore } from "react";
import {
  agentActivityPlaneAnswers,
  agentActivityPlaneCoversHost,
  getEpicAgentActivity,
  subscribeAgentActivity,
  subscribeAgentActivityPlaneHealth,
} from "@/stores/agent-activity-store";

/**
 * MRU registry for live Epic sessions. Keeps up to `maxLive` open in the background so
 * tab-switching is instant; evicts the oldest synced / inactive handle once the cap is exceeded.
 */
export { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";

/**
 * Soft threshold on retained-dirty buffers (see {@link RetainedUnsyncedBuffer}). Deliberately a
 * MONITOR, not an enforced cap.
 */
const RETAINED_UNSYNCED_SOFT_CAP = 16;

/** Whether the runtime worker behind a handle has reported a FATAL. */
const handleWorkerLiveness = new WeakMap<
  OpenEpicStoreHandle,
  { dead: boolean }
>();

/** Why the Epic SESSION owner deliberately ended its durable transport. */
export type EpicSessionTransportCloseTrigger =
  | "prune"
  | "tab-close"
  | "retry-rebuild"
  | "repoint"
  | "sign-out"
  | "construction-failed";

const handleTransportCloseAttribution = new WeakMap<
  OpenEpicStoreHandle,
  (trigger: EpicSessionTransportCloseTrigger) => void
>();

/** Binds a provider-owned transport to the registry that decides its fate. */
export function trackEpicSessionTransportCloseAttribution(
  handle: OpenEpicStoreHandle,
  attribute: (trigger: EpicSessionTransportCloseTrigger) => void,
): void {
  handleTransportCloseAttribution.set(handle, attribute);
}

export function attributeEpicSessionTransportClose(
  handle: OpenEpicStoreHandle,
  trigger: EpicSessionTransportCloseTrigger,
): void {
  handleTransportCloseAttribution.get(handle)?.(trigger);
}

function transportCloseTriggerForCause(
  cause: SessionDisposeCause,
): EpicSessionTransportCloseTrigger {
  switch (cause) {
    case "idle-expired":
    case "warm-overflow":
      return "prune";
    case "released":
      return "tab-close";
    case "scope-mismatch":
    case "unusable":
      return "retry-rebuild";
    case "replaced":
      return "repoint";
    case "dispose-all":
      return "sign-out";
  }
}

/** Binds a handle to the liveness cell its own fatal relay writes. */
export function trackEpicSessionHandleLiveness(
  handle: OpenEpicStoreHandle,
  liveness: { dead: boolean },
): void {
  handleWorkerLiveness.set(handle, liveness);
}

/** Whether this handle's runtime is gone. */
export function isEpicSessionHandleDead(handle: OpenEpicStoreHandle): boolean {
  return handleWorkerLiveness.get(handle)?.dead ?? false;
}

/** Every epic entry shares one scope. */
const EPIC_SESSION_SCOPE = "epic";

export interface OpenEpicSessionRegistryOptions {
  /** The resident cap. */
  readonly maxLive: number | (() => number);
}

interface EpicRegistrySession {
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle;
  /**
   * Unsubscribe from the handle's unsynced-queue signal. Reaped on release / disposeAll so we don't
   * leak a zustand subscription after the underlying session is gone.
   */
  unsubscribe: (() => void) | null;
  /**
   * Unsubscribe from the cross-epic agent-activity signal that gates
   * this entry's prune eligibility.
   */
  unsubscribeActivity: (() => void) | null;
  /**
   * Last-seen value of the store/doc fields that affect prune eligibility or the unsynced-edits
   * projection. The zustand subscription fires on every `projection.revision` bump (i.e.
   */
  lastEligibilityKey: string;
  /**
   * The retention answer for the teardown that is about to happen, or `null` to destroy the handle
   * with its edits.
   */
  pendingRetention: RetainedHandleIdentity | null;
}

function eligibilityKeyFor(
  epicId: string,
  handle: OpenEpicStoreHandle,
): string {
  const state = handle.store.getState();
  const metaTitle = state.snapshotMeta?.epicLight?.title ?? "";
  // `resolveUnsyncedTitle` PREFERS the live `Y.Doc` title over `metaTitle` (see below), so a key
  // that only watched `metaTitle` could sit unchanged while the title the projection would actually
  const liveTitle = readLiveTitle(handle);
  // Every LIVE input of the two cap predicates is in the key, or a session that just became
  // evictable would not trigger a prune until an unrelated field moved: `holdsNothingToLose` reads
  return `${holdsNothingToLose(state) ? 1 : 0}:${epicIsBusy(epicId, handle.hostId) ? 1 : 0}:${state.isDirty ? 1 : 0}:${state.unsyncedQueueSize}:${state.writeCommands.length}:${metaTitle}:${liveTitle}`;
}

/** THE cap's data-loss gate: nothing this session holds would be lost by disposing it. */
function holdsNothingToLose(state: OpenEpicState): boolean {
  return (
    !state.isDirty &&
    state.writeCommands.length === 0 &&
    state.unsyncedQueueSize === 0
  );
}

/**
 * The cap's "something is in progress" gate: an agent is working in the epic, OR the activity
 * plane cannot currently say that none is.
 */
function epicIsBusy(epicId: string, hostId: string): boolean {
  if (!agentActivityPlaneAnswers()) return true;
  if (hasActiveAgentWork(epicId)) return true;
  return !agentActivityPlaneCoversHost(hostId);
}

/** Per-Epic unsynced-edits summary, aggregated across every live session in the registry. */
export interface UnsyncedEditsEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty: boolean;
  /**
   * True when some part of this row's work can NEVER sync: a buffer retained across a host re-point
   * had `detachTransport()` called on it, so it is a live `Y.Doc` with no socket and no local
   */
  readonly unsyncable: boolean;
}

/** The walk's own row. */
type UnsyncedRow = UnsyncedEditsEntry;

function toWireEntry(row: UnsyncedRow): UnsyncedEditsEntry {
  return {
    epicId: row.epicId,
    title: row.title,
    queueSize: row.queueSize,
    isDirty: row.isDirty,
    unsyncable: row.unsyncable,
  };
}

/** A dirty session preserved across a host re-point (F10). */
interface RetainedUnsyncedBuffer {
  readonly epicId: string;
  /** The construction stamp of the handle that was retained - the host it was built for. */
  readonly hostStamp: string | null;
  /**
   * The owner identity this buffer belongs to, or `null` when the reading was not available at
   * retention time (legitimate after B5's honest-absent write).
   */
  readonly ownerIdentityKey: string | null;
  /** Monotonic, so two retentions for one epic can never collide in storage. */
  readonly seq: number;
  readonly handle: OpenEpicStoreHandle;
  /** Summed on merge; frozen otherwise. */
  queueSize: number;
}

/**
 * How a handle being retained identifies itself: the host it was constructed for, and the owner
 * identity that host was proven to have at the time.
 */
export interface RetainedHandleIdentity {
  readonly hostStamp: string | null;
  readonly ownerIdentityKey: string | null;
}

/**
 * What `replaceMounted` needs to know about the handle it is displacing: who it was (for the
 * retention's merge rules) and whether its edits ALREADY reached the replacement.
 */
export interface ReplacedHandleDisposition extends RetainedHandleIdentity {
  readonly editsTransferredToReplacement: boolean;
}

/** The existing retention a new one should merge into, or `null` for none. */
function findMergeTarget(
  bucket: readonly RetainedUnsyncedBuffer[],
  identity: RetainedHandleIdentity,
): RetainedUnsyncedBuffer | null {
  if (identity.hostStamp === null) return null;
  if (identity.ownerIdentityKey === null) return null;
  return (
    bucket.find(
      (buffer) =>
        buffer.hostStamp === identity.hostStamp &&
        buffer.ownerIdentityKey === identity.ownerIdentityKey,
    ) ?? null
  );
}

/** Registry lifecycle: */
export class OpenEpicSessionRegistry {
  private readonly sessions: SessionRegistry<EpicRegistrySession>;
  private releaseListener: ((epicId: string) => void) | null = null;
  /** Cached snapshot of the last-computed `getUnsyncedEdits()` result. */
  private cachedUnsynced: ReadonlyArray<UnsyncedEditsEntry> = [];
  private cachedKey: string = "";
  /** Dirty sessions preserved across a host re-point, by epic. */
  private readonly retained = new Map<string, RetainedUnsyncedBuffer[]>();
  private retainedCount: number = 0;
  private retainedSoftCapLogged: boolean = false;
  private nextRetentionSeq: number = 0;
  /** Bumped by `disposeAll` - the sign-out / user-switch boundary. */
  private disposalGeneration: number = 0;
  /**
   * The per-epic twin, bumped by `disposeRetainedForEpic` - tab close and the user's explicit
   * discard.
   */
  private readonly epicDisposalGeneration = new Map<string, number>();

  constructor(options: OpenEpicSessionRegistryOptions) {
    this.sessions = createSessionRegistry<EpicRegistrySession>({
      environment: createRendererRuntimeEnvironment(),
      policy: {
        // No clock: this plane prunes on acquire and on an eligibility change,
        // never on elapsed time.
        idleTtlMs: null,
        // A getter, read on every cap walk - see `maxLive`.
        get maxWarm(): number {
          return typeof options.maxLive === "function"
            ? options.maxLive()
            : options.maxLive;
        },
        // `DEFAULT_MAX_LIVE_EPICS` bounds the RESIDENT set, so a mounted epic counts against the cap even
        // though it can never be the entry the walk evicts.
        warmCapScope: "all-entries",
        // Not consulted under `"all-entries"`; every entry is counted already.
        busyCountsTowardWarmCap: true,
        maxActiveDeferMs: null,
        // `releaseMounted` decrements without touching `lastUsedAt`: the epic a prune picks is the least
        // recently USED, not the least recently released.
        refreshOrderOnRelease: false,
        retainWhenIdle: () => true,
        // Agent working, plane blind, or a union that does not reach this
        // session's host - see `epicIsBusy`.
        hasActiveWork: (session) =>
          epicIsBusy(session.epicId, session.handle.hostId),
        // Never evict a session holding unsynced edits or unflushed writes.
        // The transport is NOT consulted - see `holdsNothingToLose`.
        isEvictable: (session) =>
          holdsNothingToLose(session.handle.store.getState()),
        onBeforeDispose: (session, cause) => {
          // Attribute BEFORE either teardown arm.
          attributeEpicSessionTransportClose(
            session.handle,
            transportCloseTriggerForCause(cause),
          );
          // Same teardown for every route out of the registry, retention included: the entry's subscriptions
          // close over it and call `prune()`/`emit()`, and it is no longer registered for either to be
          unsubscribeSession(session);
          // Desktop ownership belongs to the tab/Epic, not to one transient transport during that tab's
          // lifetime, so a re-point deliberately does not announce a release.
          if (cause !== "replaced") this.releaseListener?.(session.epicId);
          const retention = session.pendingRetention;
          session.pendingRetention = null;
          if (retention === null) return "dispose";
          this.retainDirtyHandle(session, retention);
          return "retain";
        },
        dispose: (session) => {
          session.handle.dispose();
        },
        onParked: () => {},
        onRevived: () => {},
      },
    });
  }

  size(): number {
    return this.sessions.size();
  }

  /** How many separate buffers are retained for an epic. */
  retainedCountForTests(epicId: string): number {
    return this.retained.get(epicId)?.length ?? 0;
  }

  /**
   * Each retained buffer's own `queueSize`, in bucket order. The second half of the same seam, and
   * it exists because the COUNT alone cannot see the merge's optimistic credit.
   */
  retainedQueueSizesForTests(epicId: string): readonly number[] {
    return (this.retained.get(epicId) ?? []).map((buffer) => buffer.queueSize);
  }

  setReleaseListener(listener: ((epicId: string) => void) | null): void {
    this.releaseListener = listener;
  }

  get(epicId: string): OpenEpicStoreHandle | null {
    return this.sessions.get(epicId)?.handle ?? null;
  }

  /** Read a live session handle without changing MRU ordering. */
  peek(epicId: string): OpenEpicStoreHandle | null {
    return this.sessions.peek(epicId)?.handle ?? null;
  }

  acquire(
    epicId: string,
    factory: (epicId: string) => OpenEpicStoreHandle,
  ): OpenEpicStoreHandle {
    return this.sessions.transact(() => {
      const handle = this.sessions.materialize(epicId, EPIC_SESSION_SCOPE, () =>
        this.createSession(epicId, factory(epicId)),
      ).handle;
      this.sessions.pruneWarm();
      this.sessions.notify();
      return handle;
    });
  }

  acquireMounted(
    epicId: string,
    factory: (epicId: string) => OpenEpicStoreHandle,
  ): OpenEpicStoreHandle {
    return this.sessions.transact(() => {
      // THE SEAM, and the reason the check is here rather than at a caller.
      this.retireIfDead(epicId);
      const handle = this.sessions.acquire(epicId, EPIC_SESSION_SCOPE, () =>
        this.createSession(epicId, factory(epicId)),
      ).handle;
      this.sessions.pruneWarm();
      this.sessions.notify();
      return handle;
    });
  }

  /**
   * Drop the mounted handle for `epicId` when its RUNTIME is gone, so the acquire that follows
   * builds a replacement.
   */
  private retireIfDead(epicId: string): void {
    const entry = this.sessions.peekEntry(epicId);
    if (entry === null) return;
    if (!isEpicSessionHandleDead(entry.session.handle)) return;
    // NO retention, stated rather than defaulted - see above for why the dirty
    // test would answer "the only copy" about a document nothing can read.
    entry.session.pendingRetention = null;
    attributeEpicSessionTransportClose(entry.session.handle, "retry-rebuild");
    this.sessions.discard(epicId, "released");
  }

  releaseMounted(epicId: string): void {
    this.sessions.transact(() => {
      // `"warm"` because a dropped mount reference is not a decision about the session - the tab is
      // still open, and the cap is what decides whether this epic stays resident.
      this.sessions.release(epicId, "warm");
      this.sessions.pruneWarm();
      this.sessions.notify();
    });
  }

  /** Atomically replaces the mounted handle for an Epic after a safe re-point. */
  replaceMounted(
    epicId: string,
    previousHandle: OpenEpicStoreHandle,
    nextHandle: OpenEpicStoreHandle,
    previousDisposition: ReplacedHandleDisposition,
  ): boolean {
    return this.sessions.transact(() => {
      const entry = this.sessions.peekEntry(epicId);
      if (entry === null || entry.session.handle !== previousHandle) {
        return false;
      }
      // Below `@1.2` the cross-host merge is unreachable, so this dispose WAS the data loss (F10).
      entry.session.pendingRetention =
        previousHandle.store.getState().isDirty &&
        !previousDisposition.editsTransferredToReplacement
          ? previousDisposition
          : null;
      const replaced = this.sessions.replace(
        epicId,
        entry.session,
        this.createSession(epicId, nextHandle),
      );
      if (!replaced) {
        entry.session.pendingRetention = null;
        return false;
      }
      this.sessions.pruneWarm();
      this.sessions.notify();
      return true;
    });
  }

  /** Move a dirty handle out of the registry and into the retention, transport first. */
  /**
   * Transfers a merged-from handle's root state into its target, and disposes it ONLY once the
   * target has affirmatively taken the update.
   */
  private mergeRetainedThenDispose(
    source: EpicRegistrySession,
    identity: RetainedHandleIdentity,
    target: RetainedUnsyncedBuffer,
    creditedQueueSize: number,
  ): void {
    // Captured BEFORE the first await, so the comparison below is against the
    // world this merge was started in.
    const startedAtDisposal = this.disposalGeneration;
    const startedAtEpicDisposal =
      this.epicDisposalGeneration.get(source.epicId) ?? 0;
    const keepSourceAsItsOwnBuffer = (): void => {
      if (
        this.disposalGeneration !== startedAtDisposal ||
        (this.epicDisposalGeneration.get(source.epicId) ?? 0) !==
          startedAtEpicDisposal
      ) {
        // The registry we would retain into has been torn down since.
        source.handle.dispose();
        return;
      }
      // The credit named a transfer that did not happen.
      target.queueSize -= creditedQueueSize;
      this.appendRetainedBuffer(source, identity, creditedQueueSize);
    };
    void source.handle
      .encodeRootState()
      .then((update) => target.handle.applyRootUpdate(update, false))
      .then((applied) => {
        if (!applied) {
          keepSourceAsItsOwnBuffer();
          return;
        }
        source.handle.dispose();
      })
      .catch(() => {
        // "I could not ask." The edits are still only here.
        keepSourceAsItsOwnBuffer();
      });
  }

  private retainDirtyHandle(
    session: EpicRegistrySession,
    identity: RetainedHandleIdentity,
  ): void {
    // Before anything else: stop it dialing.
    session.handle.detachTransport();

    const queueSize = session.handle.store.getState().unsyncedQueueSize;
    const bucket = this.retained.get(session.epicId) ?? [];
    const mergeTarget = findMergeTarget(bucket, identity);
    if (mergeTarget !== null) {
      // Same epic, same host, same proven owner identity - so the same room, which is what makes this
      // legal with no `roomId` and therefore legal below `@1.2`.
      mergeTarget.queueSize += queueSize;
      // Through the PORT, and asynchronously.
      this.mergeRetainedThenDispose(session, identity, mergeTarget, queueSize);
      return;
    }

    this.appendRetainedBuffer(session, identity, queueSize);
  }

  /** The retention's one growth point, so the merge's failure path reuses it. */
  private appendRetainedBuffer(
    session: EpicRegistrySession,
    identity: RetainedHandleIdentity,
    queueSize: number,
  ): void {
    const bucket = this.retained.get(session.epicId) ?? [];
    this.nextRetentionSeq += 1;
    bucket.push({
      epicId: session.epicId,
      hostStamp: identity.hostStamp,
      ownerIdentityKey: identity.ownerIdentityKey,
      seq: this.nextRetentionSeq,
      handle: session.handle,
      queueSize,
    });
    this.retained.set(session.epicId, bucket);
    this.retainedCount += 1;
    this.warnOnceIfRetentionGrowthLooksWrong();
  }

  private warnOnceIfRetentionGrowthLooksWrong(): void {
    if (this.retainedCount <= RETAINED_UNSYNCED_SOFT_CAP) return;
    if (this.retainedSoftCapLogged) return;
    this.retainedSoftCapLogged = true;
    // Logged, never enforced. Dropping one of these would destroy unsynced edits the user was never
    // offered a decision about, which is the defect the retention exists to fix.
    appLogger.error(
      "[open-epic-session-registry] retained unsynced buffers above soft cap",
      {
        retainedCount: this.retainedCount,
        softCap: RETAINED_UNSYNCED_SOFT_CAP,
      },
      new Error("retained unsynced buffers above soft cap"),
    );
  }

  private disposeRetainedForEpic(epicId: string): void {
    // Bumped BEFORE the early return: a merge can be in flight for an epic whose bucket is momentarily
    // absent, and that source is exactly the one this fence is for.
    this.epicDisposalGeneration.set(
      epicId,
      (this.epicDisposalGeneration.get(epicId) ?? 0) + 1,
    );
    const bucket = this.retained.get(epicId);
    if (bucket === undefined) return;
    this.retained.delete(epicId);
    this.retainedCount -= bucket.length;
    for (const buffer of bucket) {
      buffer.handle.dispose();
    }
  }

  private createSession(
    epicId: string,
    handle: OpenEpicStoreHandle,
  ): EpicRegistrySession {
    const session: EpicRegistrySession = {
      epicId,
      handle,
      unsubscribe: null,
      unsubscribeActivity: null,
      lastEligibilityKey: eligibilityKeyFor(epicId, handle),
      pendingRetention: null,
    };
    const handleEligibilityChange = (): void => {
      const nextKey = eligibilityKeyFor(epicId, handle);
      if (nextKey === session.lastEligibilityKey) return;
      session.lastEligibilityKey = nextKey;
      this.sessions.transact(() => {
        this.sessions.pruneWarm();
        this.sessions.notify();
      });
    };
    // Subscribe to the underlying store so prune-relevant changes trigger a registry-level emit.
    const maybeSubscribe = handle.store.subscribe;
    session.unsubscribe =
      typeof maybeSubscribe === "function"
        ? maybeSubscribe.call(handle.store, handleEligibilityChange)
        : null;
    // Agent activity is no longer carried by this epic's own awareness, so the guard re-evaluates off
    // the per-user room instead.
    const unsubscribeWorkingSet = subscribeAgentActivity(
      handleEligibilityChange,
    );
    // The plane's HEALTH moves on different fields than its working set (a re-open with an empty union
    // keeps the same empty map), and `epicIsBusy` reads both, so both must wake the eligibility check.
    const unsubscribePlaneHealth = subscribeAgentActivityPlaneHealth(
      handleEligibilityChange,
    );
    session.unsubscribeActivity = () => {
      unsubscribeWorkingSet();
      unsubscribePlaneHealth();
    };
    return session;
  }

  /** Dispose the live session for an epic. */
  /**
   * `dirtyLiveHandle` is the identity to RETAIN the live entry under when it holds unsynced edits,
   * or `null` to destroy it with them.
   */
  release(
    epicId: string,
    retainedBuffers: "discard" | "keep",
    dirtyLiveHandle: RetainedHandleIdentity | null,
  ): void {
    this.releaseWithTransportTrigger(
      epicId,
      retainedBuffers,
      dirtyLiveHandle,
      "tab-close",
    );
  }

  /** Rebuilds the session without mislabelling the teardown as a tab close. */
  releaseForRetryRebuild(
    epicId: string,
    retainedBuffers: "discard" | "keep",
    dirtyLiveHandle: RetainedHandleIdentity | null,
  ): void {
    this.releaseWithTransportTrigger(
      epicId,
      retainedBuffers,
      dirtyLiveHandle,
      "retry-rebuild",
    );
  }

  /** Applies the auth boundary while preserving its close attribution. */
  releaseForSignOut(
    epicId: string,
    retainedBuffers: "discard" | "keep",
    dirtyLiveHandle: RetainedHandleIdentity | null,
  ): void {
    this.releaseWithTransportTrigger(
      epicId,
      retainedBuffers,
      dirtyLiveHandle,
      "sign-out",
    );
  }

  private releaseWithTransportTrigger(
    epicId: string,
    retainedBuffers: "discard" | "keep",
    dirtyLiveHandle: RetainedHandleIdentity | null,
    trigger: EpicSessionTransportCloseTrigger,
  ): void {
    this.sessions.transact(() => {
      if (retainedBuffers === "discard") {
        // Ordered before the early return: a retention must not outlive the tab
        // that could have acted on it, even if the live entry is already gone.
        this.disposeRetainedForEpic(epicId);
      }
      const entry = this.sessions.peekEntry(epicId);
      if (entry === null) {
        this.sessions.notify();
        return;
      }
      // Must precede `discard`: `onBeforeDispose` sees only the shared `released` cause.
      attributeEpicSessionTransportClose(entry.session.handle, trigger);
      const retainsLiveEdits =
        retainedBuffers === "keep" &&
        dirtyLiveHandle !== null &&
        entry.session.handle.store.getState().isDirty;
      entry.session.pendingRetention = retainsLiveEdits
        ? dirtyLiveHandle
        : null;
      this.sessions.discard(epicId, "released");
      this.sessions.notify();
    });
  }

  /**
   * Discard every unsynced edit for an epic - live session and retained buffers alike. The action
   * half of "merge for presentation, enumerate for action".
   */
  drainUnsyncedEdits(epicId: string): void {
    this.sessions.transact(() => {
      const session = this.sessions.peek(epicId);
      if (session !== null) {
        session.handle.store.getState().discardUnsyncedEdits();
      }
      this.disposeRetainedForEpic(epicId);
      this.sessions.notify();
    });
  }

  requestFreshSnapshot(epicId: string): void {
    this.sessions.transact(() => {
      const session = this.sessions.peek(epicId);
      if (session === null) return;
      session.handle.requestFreshSnapshot();
      this.sessions.notify();
    });
  }

  disposeAll(): void {
    this.sessions.transact(() => {
      this.sessions.disposeAll();
      // Retentions go too. This is the auth lifecycle's hook - sign-out, user-switch, token expiry - and
      // its whole contract is that no prior identity's Y.Doc survives into the next session.
      for (const bucket of this.retained.values()) {
        for (const buffer of bucket) {
          buffer.handle.dispose();
        }
      }
      this.retained.clear();
      this.retainedCount = 0;
      this.retainedSoftCapLogged = false;
      // Fences every merge currently in flight.
      this.disposalGeneration += 1;
      this.sessions.notify();
    });
  }

  /**
   * Snapshot of every live session that currently has unsynced edits. Keyed by epicId; value carries
   * the best-available title (live Y.Doc title, falling back to snapshot-meta epicLight).
   */
  /** The ONE walk over both collections. */
  private collectUnsyncedRows(): UnsyncedRow[] {
    const out: UnsyncedRow[] = [];
    const seen = new Set<string>();
    for (const session of this.sessions.list()) {
      const state = session.handle.store.getState();
      const retainedBucket = this.retained.get(session.epicId) ?? [];
      const retainedQueueSize = sumRetainedQueueSize(retainedBucket);
      seen.add(session.epicId);
      // The row's EXISTENCE condition, not just its content: a clean live session beside a dirty
      // retained buffer must still produce a row.
      if (!state.isDirty && retainedBucket.length === 0) continue;
      out.push({
        epicId: session.epicId,
        title: resolveUnsyncedTitle(
          liveTitleCandidates(session.handle, state).concat(
            retainedTitleCandidates(retainedBucket),
          ),
          session.epicId,
        ),
        queueSize: state.unsyncedQueueSize + retainedQueueSize,
        isDirty: state.isDirty || retainedBucket.length > 0,
        // Keyed on the RETENTION alone, never on the live session's state: the live half's dirtiness is a
        // different question and must not enter.
        unsyncable: retainedBucket.length > 0,
      });
    }
    // Retentions whose live session is gone. Reachable while a tab is open on
    // an epic whose live entry was pruned, and the buffer still holds work.
    for (const [epicId, bucket] of this.retained) {
      if (seen.has(epicId)) continue;
      if (bucket.length === 0) continue;
      out.push({
        epicId,
        title: resolveUnsyncedTitle(retainedTitleCandidates(bucket), epicId),
        queueSize: sumRetainedQueueSize(bucket),
        isDirty: true,
        // This loop IS the retained-only arm, so every row it emits is
        // unsyncable by construction.
        unsyncable: true,
      });
    }
    return out;
  }

  /**
   * True when this epic has unsynced edits anywhere - live session or retained buffer. The predicate
   * behind every tab-close, window-move and discard-confirmation gate.
   */
  hasUnsyncedEdits(epicId: string): boolean {
    // A real projection of the shared walk, not a parallel implementation.
    return this.collectUnsyncedRows().some((row) => row.epicId === epicId);
  }

  getUnsyncedEdits(): ReadonlyArray<UnsyncedEditsEntry> {
    const out = this.collectUnsyncedRows().map(toWireEntry);
    // EVERY wire field is in the key.
    const cacheKey = JSON.stringify(out);
    if (cacheKey === this.cachedKey) {
      return this.cachedUnsynced;
    }
    this.cachedKey = cacheKey;
    this.cachedUnsynced = out;
    return out;
  }

  /** The rows holding work that can NEVER reach a server, newest walk each call. */
  unsyncableWork(): ReadonlyArray<UnsyncedEditsEntry> {
    return this.collectUnsyncedRows()
      .filter((row) => row.unsyncable)
      .map(toWireEntry);
  }

  subscribe(listener: () => void): () => void {
    return this.sessions.subscribe(listener);
  }

  /** Evict least-recently-used clean and inactive entries until size <= maxLive. */
  prune(): void {
    this.sessions.pruneWarm();
  }
}

function unsubscribeSession(session: EpicRegistrySession): void {
  if (session.unsubscribe !== null) session.unsubscribe();
  if (session.unsubscribeActivity !== null) session.unsubscribeActivity();
  session.unsubscribe = null;
  session.unsubscribeActivity = null;
}

/**
 * Prune guard: never evict a session whose epic has an agent working on it. Reads the
 * host-selected activity view rather than the epic's own collaboration awareness.
 */
function hasActiveAgentWork(epicId: string): boolean {
  return getEpicAgentActivity(epicId).working.size > 0;
}

/**
 * First candidate that resolves to something real, live sources before retained, `epicId` only
 * when nothing does.
 */
function resolveUnsyncedTitle(
  candidates: readonly string[],
  epicId: string,
): string {
  return candidates.find((candidate) => candidate.length > 0) ?? epicId;
}

function liveTitleCandidates(
  handle: OpenEpicStoreHandle,
  state: OpenEpicState,
): string[] {
  return [readLiveTitle(handle), state.snapshotMeta?.epicLight?.title ?? ""];
}

function retainedTitleCandidates(
  bucket: readonly RetainedUnsyncedBuffer[],
): string[] {
  return bucket.flatMap((buffer) => [
    readLiveTitle(buffer.handle),
    buffer.handle.store.getState().snapshotMeta?.epicLight?.title ?? "",
  ]);
}

function sumRetainedQueueSize(
  bucket: readonly RetainedUnsyncedBuffer[],
): number {
  return bucket.reduce((total, buffer) => total + buffer.queueSize, 0);
}

function readLiveTitle(handle: OpenEpicStoreHandle): string {
  // The PROJECTION, not the doc. `projectEpicHeader` performs the identical read -
  // `getEpicMap(doc)`, `readMaybeString(epic, "title")`, which is `typeof value === "string" ?
  const state: Partial<OpenEpicState> = handle.store.getState();
  const epic = state.epic;
  return typeof epic?.title === "string" ? epic.title : "";
}

/** React-side hook that returns the current aggregated unsynced-edits map from a registry. */
export function useRegistryUnsyncedEdits(
  registry: OpenEpicSessionRegistry,
): ReadonlyArray<UnsyncedEditsEntry> {
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getUnsyncedEdits(),
    () => EMPTY_UNSYNCED,
  );
}

const EMPTY_UNSYNCED: ReadonlyArray<UnsyncedEditsEntry> = [];
