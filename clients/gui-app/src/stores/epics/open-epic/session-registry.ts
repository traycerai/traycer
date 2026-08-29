import type { EpicHeader } from "./types";
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import {
  createSessionRegistry,
  type SessionRegistry,
} from "@traycer-clients/shared/replica-runtime";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { appLogger } from "@/lib/logger";
import { useSyncExternalStore } from "react";
import {
  getEpicAgentActivity,
  subscribeAgentActivity,
} from "@/stores/agent-activity-store";

/**
 * MRU registry for live Epic sessions. Keeps up to 5 open in the background
 * so tab-switching is instant; evicts the oldest **clean / synced / inactive**
 * handle once the cap is exceeded.
 *
 * Soft-cap rule: if every entry is dirty (unsynced edits pending, or still
 * reconnecting with unflushed writes) or has active agent work, the registry
 * temporarily stays above the cap until at least one entry becomes clean and
 * inactive, at which point it prunes down to the cap. Closing an Epic tab
 * forcibly disposes that session regardless of the cap.
 *
 * The warm-pool CORE - the entry map, the mounted-reference count, the MRU
 * ordering, the cap walk, the one teardown path, the listener set - is the
 * shared `createSessionRegistry`, which the chat and terminal registries also
 * run on. What is genuinely this plane's stays here: the retention of dirty
 * handles across a host re-point, the unsynced-edits projection over both
 * collections, the desktop ownership release listener, and the per-entry
 * eligibility subscriptions that make a prune-relevant change observable at
 * all.
 */
export { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";

/**
 * Soft threshold on retained-dirty buffers (see {@link RetainedUnsyncedBuffer}).
 *
 * Deliberately a MONITOR, not an enforced cap. Every eviction policy available
 * at this layer destroys unsynced edits the user has not been offered a
 * decision about - which is the exact defect the retention exists to fix, so a
 * hard cap would reintroduce it through a different door. Crossing this logs
 * once at `error`; nothing is dropped.
 *
 * What actually bounds the collection is the retirement set: only dirty
 * handles are retained at all, a second retention for the same
 * `(epicId, hostStamp)` merges rather than appends, and closing the tab,
 * draining, or signing out reclaims. Growing past this therefore means an
 * epic is being re-pointed repeatedly, dirty every time, with its tab never
 * closed - worth a log line, not worth deleting a user's work over.
 */
const RETAINED_UNSYNCED_SOFT_CAP = 16;

/**
 * Every epic entry shares one scope. The registry's scope key discriminates
 * REBUILDS within one identity, and this plane has none: a re-point goes
 * through {@link OpenEpicSessionRegistry.replaceMounted}, which is an explicit
 * swap with its own retention rules, not a rebuild the registry may perform on
 * its own.
 */
const EPIC_SESSION_SCOPE = "epic";

export interface OpenEpicSessionRegistryOptions {
  readonly maxLive: number;
}

/**
 * What the registry holds per epic: the handle, the subscriptions that make a
 * prune-relevant change observable, and the call-scoped retention answer for
 * whichever teardown is about to happen.
 */
interface EpicRegistrySession {
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle;
  /**
   * Unsubscribe from the handle's unsynced-queue signal. Reaped on
   * release / disposeAll so we don't leak a zustand subscription after
   * the underlying session is gone.
   */
  unsubscribe: (() => void) | null;
  /**
   * Unsubscribe from the cross-epic agent-activity signal that gates
   * this entry's prune eligibility.
   */
  unsubscribeActivity: (() => void) | null;
  /**
   * Last-seen value of the store/doc fields that affect prune eligibility or
   * the unsynced-edits projection. The zustand subscription fires on every
   * `projection.revision` bump (i.e. every keystroke); gating prune/emit on
   * this cache key keeps Y-update bursts from re-running the MRU walk and
   * re-emitting to every React subscriber per character.
   */
  lastEligibilityKey: string;
  /**
   * The retention answer for the teardown that is about to happen, or `null`
   * to destroy the handle with its edits.
   *
   * Recorded on the outgoing session BY THE CALL that knows it, because that is
   * where the answer lives: whether a dirty handle should be retained depends
   * on the host stamp and owner identity the caller can prove, and on whether
   * the caller already transferred those edits into a replacement - none of
   * which is readable off the session. `onBeforeDispose` consumes it and clears
   * it, so it can never be read by a later, unrelated teardown.
   */
  pendingRetention: RetainedHandleIdentity | null;
}

function eligibilityKeyFor(
  epicId: string,
  handle: OpenEpicStoreHandle,
): string {
  const state = handle.store.getState();
  const metaTitle = state.snapshotMeta?.epicLight?.title ?? "";
  // `resolveUnsyncedTitle` PREFERS the live `Y.Doc` title over `metaTitle`
  // (see below), so a key that only watched `metaTitle` could sit unchanged
  // while the title the projection would actually show moved - a title
  // landing in the doc on an already-dirty session bumps nothing here, no
  // `emit()` fires, and the React-subscribed quit sheet keeps showing the
  // bare epicId while an imperative `getUnsyncedEdits()` call already sees
  // the real title. Reading it here too keeps the two in lockstep.
  const liveTitle = readLiveTitle(handle);
  return `${handle.isClean() ? 1 : 0}:${hasActiveAgentWork(epicId) ? 1 : 0}:${state.isDirty ? 1 : 0}:${state.unsyncedQueueSize}:${metaTitle}:${liveTitle}`;
}

/**
 * Per-Epic unsynced-edits summary, aggregated across every live session
 * in the registry. T8 (desktop app-quit intercept) subscribes to this so
 * it can render the "these tabs have unsynced edits" confirmation sheet
 * without knowing which browser hooks live in which provider.
 */
export interface UnsyncedEditsEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty: boolean;
  /**
   * True when some part of this row's work can NEVER sync: a buffer retained
   * across a host re-point had `detachTransport()` called on it, so it is a
   * live `Y.Doc` with no socket and no local persistence, and its store is
   * frozen at retention time. A dirty LIVE session is not unsyncable - it
   * still holds a transport and drains when its host returns.
   *
   * ON THE WIRE DELIBERATELY, and this is the moment the note that used to sit
   * on `UnsyncedRow` reserved for it: "if a main-side consumer ever genuinely
   * needs durability, that is the moment to extend the wire contract
   * deliberately, with the parser and the merge updated together." The
   * consumer arrived - `requestAppUpdateInstall` has to know about work in
   * ANOTHER WINDOW, because `installUpdate()` restarts the whole app and the
   * update quit deliberately bypasses the unsynced-edits interception. A
   * per-renderer registry cannot see it; only main's per-window map can.
   *
   * The three sites that rebuild this object literally therefore move
   * together, and each drops the field silently if it does not:
   * `ipc-parsers.ts` (main parsing a renderer push), `aggregateUnsyncedSnapshots`
   * (main's cross-window merge), and `mergeEntries` (the renderer's union of
   * a frozen snapshot with live rows).
   */
  readonly unsyncable: boolean;
}

/**
 * The walk's own row.
 *
 * `unsyncable` used to be INTERNAL here, off the wire on purpose, because the
 * hops that rebuild the entry as a fresh object literal would each have
 * dropped an added field silently. Those hops are now enumerated on the field
 * itself and moved with it; the reason the exclusion existed - no main-side
 * consumer needed durability - stopped holding when `installUpdate()` had to
 * ask about other windows.
 *
 * The row type stays distinct anyway, because the WALK still has facts the
 * wire does not need, and because a name for "the row before it is narrowed"
 * is what keeps `toWireEntry` an explicit projection rather than a spread.
 */
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

/**
 * A dirty session preserved across a host re-point (F10).
 *
 * Below protocol `@1.2` the host sends no `roomId`, so the cross-host document
 * merge is unreachable and `replaceMounted` would otherwise destroy the
 * outgoing handle's unsynced edits outright. Retaining it keeps the user's work
 * addressable until they are actually offered a decision about it.
 *
 * The handle here has had `detachTransport()` called on it: it holds a live
 * `Y.Doc` and no socket. Its store is frozen at retention time, which is why
 * `queueSize` is captured on the record rather than read back through the
 * store - a merge has to be able to sum it.
 */
interface RetainedUnsyncedBuffer {
  readonly epicId: string;
  /**
   * The construction stamp of the handle that was retained - the host it was
   * built for. Never substituted: a retention whose stamp is unknown is kept
   * separate rather than given a placeholder, because the merge decision keys
   * on this and a placeholder would merge two different hosts' buffers.
   */
  readonly hostStamp: string | null;
  /**
   * The owner identity this buffer belongs to, or `null` when the reading was
   * not available at retention time (legitimate after B5's honest-absent
   * write). `null` never matches anything, including another `null`.
   */
  readonly ownerIdentityKey: string | null;
  /** Monotonic, so two retentions for one epic can never collide in storage. */
  readonly seq: number;
  readonly handle: OpenEpicStoreHandle;
  /** Summed on merge; frozen otherwise. */
  queueSize: number;
}

/**
 * How a handle being retained identifies itself: the host it was constructed
 * for, and the owner identity that host was proven to have at the time.
 *
 * Supplied by the caller rather than read here on purpose. The construction
 * stamp lives in a `WeakMap` owned by the provider layer, and reaching back
 * for it would make this module import from its own consumer.
 */
export interface RetainedHandleIdentity {
  readonly hostStamp: string | null;
  readonly ownerIdentityKey: string | null;
}

/**
 * What `replaceMounted` needs to know about the handle it is displacing: who
 * it was (for the retention's merge rules) and whether its edits ALREADY
 * reached the replacement.
 *
 * The second half exists because retention and the same-room document merge
 * are two answers to the same question, and only one of them can be right per
 * re-point. When both snapshots name the same room, `EpicSessionProvider`
 * applies the outgoing `Y.Doc` into the replacement under `LOCAL_ORIGIN`
 * FIRST, which makes those edits syncable again through the new handle's
 * transport. Retaining the outgoing handle as well leaves a second buffer
 * holding the same edits with no socket - one that can never observe the
 * acknowledgements the replacement is about to receive. `isDirty` on that
 * corpse never clears, so the epic is reported unsyncable forever and the
 * quit and update-install prompts keep naming work that synced long ago,
 * until the tab is closed or the buffer is explicitly discarded.
 *
 * So a transfer is a disposal, not a retention: the edits are not lost, they
 * are in the replacement. Retention stays the answer for the case it was
 * written for (F10) - a room swap, or a host below `@1.2` that sends no
 * `roomId` at all, where nothing was transferred and destroying the handle
 * would destroy the only copy.
 */
export interface ReplacedHandleDisposition extends RetainedHandleIdentity {
  readonly editsTransferredToReplacement: boolean;
}

/**
 * The existing retention a new one should merge into, or `null` for none.
 *
 * **A merge requires positive proof on all three axes.** Same epic and same
 * host is not enough: an owner-identity rotation is only ever reachable on a
 * single host (the identity comparison returns "stable" whenever the reading
 * describes a different host), so two retentions straddling a rotation share
 * an epic and a stamp while belonging to different identities. Merging those
 * produces one buffer with no owner it can honestly flush to.
 *
 * A `null` on either side is absence of proof, not a match - including
 * `null === null`, which is why this cannot be a plain equality check. That
 * also keeps two retentions whose identity reading had not landed yet from
 * colliding on a shared "unknown" key. Costing an extra inert retention is the
 * safe direction; a wrong merge is not recoverable.
 */
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

/**
 * Registry lifecycle:
 *   - `acquire(epicId, factory)` returns the existing handle or constructs a
 *     new one via `factory(epicId)`; recency is bumped on every call so the
 *     most-recently-interacted Epic stays alive.
 *   - `release(epicId, retainedBuffers, dirtyLiveHandle)` ends that entry (tab
 *     closed): disposed, or retained as an unsynced buffer when it is dirty
 *     and the caller named an identity to retain it under.
 *   - `prune()` is run after every acquire; it disposes the least-recently
 *     used clean/inactive entries until size <= maxLive, skipping dirty or
 *     active entries.
 */
export class OpenEpicSessionRegistry {
  private readonly sessions: SessionRegistry<EpicRegistrySession>;
  private releaseListener: ((epicId: string) => void) | null = null;
  /**
   * Cached snapshot of the last-computed `getUnsyncedEdits()` result. We
   * keep it keyed by a structural cache key so `useSyncExternalStore`
   * returns a stable reference across polls where nothing changed -
   * otherwise React tears every frame.
   */
  private cachedUnsynced: ReadonlyArray<UnsyncedEditsEntry> = [];
  private cachedKey: string = "";
  /**
   * Dirty sessions preserved across a host re-point, by epic. Parallel to the
   * registry's entries and deliberately NOT reachable through them: a retained
   * buffer has no mounted tab and must never be handed back by
   * `get`/`peek`/`acquire`, or a re-point would adopt the corpse of the session
   * it just replaced.
   *
   * `prune()` cannot reach these and must not: MRU eviction exists to reclaim
   * idle *clean* sessions, and every entry here is dirty by construction.
   * Reclamation is `release` (tab closed - the user has answered the close
   * confirmation), `drainUnsyncedEdits` (the user discarded), and
   * `disposeAll` (sign-out).
   */
  private readonly retained = new Map<string, RetainedUnsyncedBuffer[]>();
  private retainedCount: number = 0;
  private retainedSoftCapLogged: boolean = false;
  private nextRetentionSeq: number = 0;

  constructor(options: OpenEpicSessionRegistryOptions) {
    this.sessions = createSessionRegistry<EpicRegistrySession>({
      environment: createRendererRuntimeEnvironment(),
      policy: {
        // No clock: this plane prunes on acquire and on an eligibility change,
        // never on elapsed time.
        idleTtlMs: null,
        maxWarm: options.maxLive,
        // `DEFAULT_MAX_LIVE_EPICS` bounds the RESIDENT set, so a mounted epic
        // counts against the cap even though it can never be the entry the
        // walk evicts.
        warmCapScope: "all-entries",
        // Not consulted under `"all-entries"`; every entry is counted already.
        busyCountsTowardWarmCap: true,
        maxActiveDeferMs: null,
        // `releaseMounted` decrements without touching `lastUsedAt`: the epic a
        // prune picks is the least recently USED, not the least recently
        // released.
        refreshOrderOnRelease: false,
        retainWhenIdle: () => true,
        hasActiveWork: (session) => hasActiveAgentWork(session.epicId),
        // Never evict a session holding unsynced edits or unflushed writes.
        isEvictable: (session) => session.handle.isClean(),
        onBeforeDispose: (session, cause) => {
          // Same teardown for every route out of the registry, retention
          // included: the entry's subscriptions close over it and call
          // `prune()`/`emit()`, and it is no longer registered for either to be
          // about.
          unsubscribeSession(session);
          // Desktop ownership belongs to the tab/Epic, not to one transient
          // transport during that tab's lifetime, so a re-point deliberately
          // does not announce a release. Announced on the retention arm too:
          // the live SESSION is gone either way, and a retained buffer has no
          // transport and claims nothing, so holding that ownership open for it
          // would pin the epic to a window that can no longer serve it.
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

  /**
   * How many separate buffers are retained for an epic.
   *
   * A test seam, and a necessary one: the projection deliberately merges every
   * retention for an epic into ONE row, so "merged into the existing buffer"
   * and "kept as a second buffer" are indistinguishable through the public
   * read path - which is the entire question the merge rules turn on.
   */
  retainedCountForTests(epicId: string): number {
    return this.retained.get(epicId)?.length ?? 0;
  }

  setReleaseListener(listener: ((epicId: string) => void) | null): void {
    this.releaseListener = listener;
  }

  get(epicId: string): OpenEpicStoreHandle | null {
    return this.sessions.get(epicId)?.handle ?? null;
  }

  /**
   * Read a live session handle without changing MRU ordering.
   *
   * Passive projections, such as the global header tab strip reading a live
   * generated epic title, must not make the epic count as recently used just
   * because React rendered or subscribed to the registry. Use `get()` only
   * when the caller is actively opening/interacting with the session.
   */
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
      const handle = this.sessions.acquire(epicId, EPIC_SESSION_SCOPE, () =>
        this.createSession(epicId, factory(epicId)),
      ).handle;
      this.sessions.pruneWarm();
      this.sessions.notify();
      return handle;
    });
  }

  releaseMounted(epicId: string): void {
    this.sessions.transact(() => {
      // `"warm"` because a dropped mount reference is not a decision about the
      // session - the tab is still open, and the cap is what decides whether
      // this epic stays resident.
      this.sessions.release(epicId, "warm");
      this.sessions.pruneWarm();
      this.sessions.notify();
    });
  }

  /**
   * Atomically replaces the mounted handle for an Epic after a safe re-point.
   *
   * The replacement inherits the existing mounted-reference count: React has
   * not unmounted its tab, it has only changed which host supplies that tab's
   * Y.Doc. Disposing the old entry deliberately skips the release listener,
   * because desktop ownership belongs to the tab/Epic, not one transient
   * transport during that tab's lifetime.
   */
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
      // The one disposal path that used to ignore the rule `prune()` already
      // follows: never destroy a session holding unsynced edits. Below `@1.2`
      // the cross-host merge is unreachable, so this dispose WAS the data loss
      // (F10). Gated on `isDirty` rather than `isClean()` deliberately -
      // `isClean()` also requires an open transport, which a re-point has by
      // definition taken away, so it would retain every failover including
      // fully-synced ones and nothing would ever retire them.
      //
      // `editsTransferredToReplacement` is the second half of that rule and has
      // to be checked FIRST: a transferred handle is still `isDirty` (its own
      // store never saw an acknowledgement and never will), so the dirty test
      // alone cannot tell "the only copy" apart from "a duplicate of what the
      // replacement now holds" - and retaining the duplicate is what pins the
      // epic as permanently unsyncable. See `ReplacedHandleDisposition`.
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

  /**
   * Move a dirty handle out of the registry and into the retention, transport
   * first. The caller has already installed the replacement, or is closing the
   * tab, so this is only ever an outgoing handle the registry no longer tracks.
   */
  /**
   * Transfers a merged-from handle's root state into its target, then disposes
   * it - after the transfer settles, in BOTH outcomes.
   *
   * `finally` and not `then`: a rejected apply still has to dispose the source,
   * because leaving it alive is a handle with no transport that nothing will
   * ever retire. What a rejection changes is the CALLER's belief about where
   * the edits live - see the provider's `editsTransferredToReplacement` - not
   * whether this handle is cleaned up.
   *
   * NO GUARD against a second merge for the same source, because there is no
   * second merge to guard against. `onBeforeDispose` nulls `pendingRetention`
   * BEFORE calling here, and the session has left the registry by then - so a
   * source is merged exactly once, structurally. A guard was written here and
   * removed: it read as protection while its condition was excluded, which is
   * the same defect as the `reparentArtifact` catch this ticket deleted.
   */
  private mergeRetainedThenDispose(
    source: OpenEpicStoreHandle,
    target: OpenEpicStoreHandle,
  ): void {
    void source
      .encodeRootState()
      .then((update) => target.applyRootUpdate(update, false))
      .catch(() => false)
      .finally(() => {
        source.dispose();
      });
  }

  private retainDirtyHandle(
    session: EpicRegistrySession,
    identity: RetainedHandleIdentity,
  ): void {
    // Before anything else: stop it dialing. A retained handle that keeps its
    // stream client reports dial evidence for a host this window has left,
    // into the selection authority's death-detection input.
    session.handle.detachTransport();

    const queueSize = session.handle.store.getState().unsyncedQueueSize;
    const bucket = this.retained.get(session.epicId) ?? [];
    const mergeTarget = findMergeTarget(bucket, identity);
    if (mergeTarget !== null) {
      // Same epic, same host, same proven owner identity - so the same room,
      // which is what makes this legal with no `roomId` and therefore legal
      // below `@1.2`. Merge rather than append; a second slot for one room
      // would show the user two rows for one task.
      mergeTarget.queueSize += queueSize;
      // Through the PORT, and asynchronously. The verdict this method serves is
      // synchronous - its caller returns `"retain"` immediately - so the async
      // tail owns exactly one thing: disposing the merged-from handle once the
      // transfer has settled. Nothing waits on a promise to decide anything.
      //
      // The window this opens is real and named: between here and the
      // `finally`, the source handle is DETACHED (line above), MERGED-FROM, and
      // NOT YET DISPOSED. Its transport is already gone, so it cannot dial or
      // claim anything; what it must not do is accept a second merge, which the
      // guard below refuses.
      this.mergeRetainedThenDispose(session.handle, mergeTarget.handle);
      return;
    }

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
    // Logged, never enforced. Dropping one of these would destroy unsynced
    // edits the user was never offered a decision about, which is the defect
    // the retention exists to fix.
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
    // Subscribe to the underlying store so prune-relevant changes trigger a
    // registry-level emit. Per-keystroke `projection.revision` bumps fire
    // the subscription too; gate on an "eligibility key" so the
    // steady-typing hot path doesn't re-run the MRU prune walk or re-emit
    // the unsynced-edits snapshot to every React subscriber per character.
    // Test fakes don't always hand back a full zustand store, so guard on
    // the method existing before calling.
    const maybeSubscribe = handle.store.subscribe;
    session.unsubscribe =
      typeof maybeSubscribe === "function"
        ? maybeSubscribe.call(handle.store, handleEligibilityChange)
        : null;
    // Agent activity is no longer carried by this epic's own awareness, so the
    // guard re-evaluates off the per-user room instead. Same contract as
    // before: an epic whose agents just started working must stop being
    // prunable without waiting for an unrelated store write.
    session.unsubscribeActivity = subscribeAgentActivity(
      handleEligibilityChange,
    );
    return session;
  }

  /**
   * Dispose the live session for an epic.
   *
   * `retainedBuffers` is required, and every caller must state it, because
   * this method has three callers meaning three different things and only one
   * of them is a user decision:
   *
   *   - the tab-close wrappers - the user answered the close confirmation,
   *     which reads the retained buffer too, so the answer covers it
   *     (`"discard"`);
   *   - a denied desktop ownership claim - an involuntary navigate-away when
   *     another window wins, no decision offered (`"keep"`);
   *   - the provider's rebuild arm, which is TWO conditions: a `userId`
   *     change is a security boundary and matches `disposeAll`'s policy
   *     (`"discard"`), while an owner-identity rotation is not
   *     (`"keep"` - see below).
   *
   * A rotation is only ever detected on ONE host, and the retained buffers can
   * belong to others. Destroying them here would delete a buffer for host A
   * because host B rotated - no decision, no log, and strictly more
   * destructive than the cross-identity MERGE `findMergeTarget` refuses three
   * methods up on the grounds that the result has no owner it could honestly
   * flush to.
   */
  /**
   * `dirtyLiveHandle` is the identity to RETAIN the live entry under when it
   * holds unsynced edits, or `null` to destroy it with them.
   *
   * It exists because `"keep"` used to mean only "spare the buffers already
   * retained", while the LIVE handle - the one actually holding the user's
   * unsynced edits - was disposed either way. On an involuntary path that is
   * exactly the silent loss the flag's own doc says it prevents: an
   * owner-identity rotation leaves `userId` unchanged, so a dirty session was
   * destroyed with no confirmation and no retention, and the edits were gone.
   *
   * Retention here follows the rule `replaceMounted` already follows for a
   * re-point - never destroy a session holding unsynced edits - and produces
   * the same kind of buffer: transport detached, reachable through the
   * unsynced-edits projection, merged into an existing retention only on
   * positive proof of the same epic, host and owner identity.
   *
   * `null` is a DECISION, not a default, which is why it is a required
   * argument: a caller that has shown the user a decision (`"discard"`), or
   * one whose loss is deliberate, says so at the call site rather than
   * inheriting it. `"discard"` ignores it - the user was asked about these
   * edits.
   */
  release(
    epicId: string,
    retainedBuffers: "discard" | "keep",
    dirtyLiveHandle: RetainedHandleIdentity | null,
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
   * Discard every unsynced edit for an epic - live session and retained
   * buffers alike.
   *
   * The action half of "merge for presentation, enumerate for action". The
   * quit sheet shows one row per epic, so Discard is one decision per epic;
   * routing it through `get(epicId)` would drain only the live session and
   * silently skip the retained buffer the row is partly about.
   *
   * Draining a retention disposes it rather than clearing its queue: its store
   * is frozen and it has no transport, so "discard these edits" and "destroy
   * this buffer" are the same operation.
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
      // Retentions go too. This is the auth lifecycle's hook - sign-out,
      // user-switch, token expiry - and its whole contract is that no prior
      // identity's Y.Doc survives into the next session. A retention that
      // outlived it would be that leak with an unsynced buffer attached, and
      // disposing the live entries alone would not touch it. The edits are
      // lost, which is the same policy already applied to a dirty live session
      // here.
      for (const bucket of this.retained.values()) {
        for (const buffer of bucket) {
          buffer.handle.dispose();
        }
      }
      this.retained.clear();
      this.retainedCount = 0;
      this.retainedSoftCapLogged = false;
      this.sessions.notify();
    });
  }

  /**
   * Snapshot of every live session that currently has unsynced edits.
   * Keyed by epicId; value carries the best-available title (live Y.Doc
   * title, falling back to snapshot-meta epicLight). Empty array means
   * every tab is either fully synced or has no unresolved local dirty state.
   */
  /**
   * The ONE walk over both collections. `getUnsyncedEdits()` and
   * {@link hasUnsyncedEdits} are both projections of it, and nothing else may
   * traverse the entries to answer "does this epic have unsynced work".
   *
   * Two independent traversals is what let the projection and
   * `epicHasUnsyncedEdits` drift apart in the first place - one gained the
   * retained buffer and the other kept answering off the live entry alone,
   * so the quit sheet protected work that tab-close discarded without asking.
   *
   * One row per epic, merged: the row is an offer to discard, discard is one
   * decision per task, so two rows for one epic would be two buttons for one
   * decision - and "live session vs retained buffer" is a fact about session
   * machinery that means nothing to the reader.
   */
  private collectUnsyncedRows(): UnsyncedRow[] {
    const out: UnsyncedRow[] = [];
    const seen = new Set<string>();
    for (const session of this.sessions.list()) {
      const state = session.handle.store.getState();
      const retainedBucket = this.retained.get(session.epicId) ?? [];
      const retainedQueueSize = sumRetainedQueueSize(retainedBucket);
      seen.add(session.epicId);
      // The row's EXISTENCE condition, not just its content: a clean live
      // session beside a dirty retained buffer must still produce a row.
      // Skipping on the live entry alone is exactly the state a re-point
      // leaves behind - new session established and clean, retained buffer
      // holding everything unsynced - so the first moment this matters is the
      // first moment F10 does.
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
        // Keyed on the RETENTION alone, never on the live session's state: the
        // live half's dirtiness is a different question and must not enter.
        // An epic can hold both at once, and the retained half is destroyed
        // just the same while the live half drains.
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
   * True when this epic has unsynced edits anywhere - live session or retained
   * buffer. The predicate behind every tab-close, window-move and
   * discard-confirmation gate.
   */
  hasUnsyncedEdits(epicId: string): boolean {
    // A real projection of the shared walk, not a parallel implementation.
    // This used to do its own entries + retained lookup, which agreed with
    // `collectUnsyncedRows` only by maintenance - and the comment above that
    // method already asserted the enforcement that did not exist. Two
    // independent traversals of this fact is exactly what let the projection
    // and `epicHasUnsyncedEdits` drift apart before, and that drift discarded
    // work without asking.
    //
    // Deliberately NOT routed through `getUnsyncedEdits()`: that memoizes on a
    // cache key built by joining every row's wire fields, which is a LIST
    // identity. A per-epic boolean must not depend on a string
    // that changes when an unrelated epic's title does. The walk is bounded by
    // `maxLive` (5) plus retentions and this is a gate on a user gesture, so it
    // stays unmemoized rather than borrowing an invalidation it does not fit.
    return this.collectUnsyncedRows().some((row) => row.epicId === epicId);
  }

  getUnsyncedEdits(): ReadonlyArray<UnsyncedEditsEntry> {
    // Mapped rather than returned as-is: `UnsyncedRow` is structurally
    // assignable to `UnsyncedEditsEntry`, so handing the walk's rows straight
    // back would put `unsyncable` on the object at RUNTIME and send it over
    // IPC, which is the thing the split exists to prevent.
    const out = this.collectUnsyncedRows().map(toWireEntry);
    // EVERY wire field is in the key. `unsyncable` was missing once: a dirty
    // live session re-pointed into a retained buffer with a clean replacement
    // leaves `queueSize` / `isDirty` / `title` unchanged while `unsyncable`
    // flips to true, so the memo kept serving the row as syncable - to the
    // lifecycle push AND to the fresh cross-window snapshot - and an app-update
    // install could restart Desktop past the discard confirmation and destroy
    // the retained document.
    // JSON.stringify, not a hand-joined delimiter: `title` is user-controlled
    // (an Epic's name), so a `:`/`|`-joined template lets a crafted title
    // collide two distinct row lists onto the same string and serve one a
    // stale cached array. JSON.stringify escapes every field it serializes,
    // so two DIFFERENT row lists can never produce the same key.
    const cacheKey = JSON.stringify(out);
    if (cacheKey === this.cachedKey) {
      return this.cachedUnsynced;
    }
    this.cachedKey = cacheKey;
    this.cachedUnsynced = out;
    return out;
  }

  /**
   * The rows holding work that can NEVER reach a server, newest walk each call.
   *
   * A DURABILITY question, not a presentation one - which is why it exists
   * beside a projection that deliberately merges live and retained into one
   * row. That merge is right for the unsynced sheet: the row is an offer to
   * discard, and "live session vs retained buffer" means nothing to the reader.
   * This asks something the reader never has to: can this work still be saved
   * at all, and may we therefore destroy it without asking?
   *
   * It answers off the RETENTION alone. A dirty live session on a dead host
   * still holds a transport and resumes when the host returns; a retained
   * buffer had `detachTransport()` called on it and there is no local
   * persistence anywhere for an epic `Y.Doc`, so the transport was its only
   * route. An epic can hold both at once, and callers must not read this as
   * "and nothing else is dirty" - the live half draining does not save the
   * retained half.
   *
   * Returns wire-shaped entries so a caller can name the affected epics
   * without `unsyncable` escaping onto a type that crosses IPC.
   */
  unsyncableWork(): ReadonlyArray<UnsyncedEditsEntry> {
    return this.collectUnsyncedRows()
      .filter((row) => row.unsyncable)
      .map(toWireEntry);
  }

  subscribe(listener: () => void): () => void {
    return this.sessions.subscribe(listener);
  }

  /**
   * Evict least-recently-used clean and inactive entries until size <= maxLive.
   * If every entry above the cap is dirty or active, we stop (soft cap) - the
   * next time a dirty entry flushes or an active entry goes idle, subsequent
   * `prune()` calls will finish the job.
   */
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
 * Prune guard: never evict a session whose epic has an agent working on it.
 *
 * Reads the host-selected activity view rather than the epic's own
 * collaboration awareness. The dedicated capability needs no live epic
 * subscription, so the guard keeps working while an epic session attaches.
 */
function hasActiveAgentWork(epicId: string): boolean {
  return getEpicAgentActivity(epicId).working.size > 0;
}

/**
 * First candidate that resolves to something real, live sources before
 * retained, `epicId` only when nothing does.
 *
 * Live-first is a preference, NOT a precedence: a freshly re-pointed session
 * has neither a populated Y.Doc title nor snapshot meta yet, so preferring the
 * live entry unconditionally would put a bare epic UUID in the quit sheet -
 * the one surface whose whole job is letting someone recognise the work they
 * are about to lose - while the retained buffer holds the real name. Falling
 * through on empty also removes a re-emit, since `title` is in the cache key.
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
  // The PROJECTION, not the doc. `projectEpicHeader` performs the identical
  // read - `getEpicMap(doc)`, `readMaybeString(epic, "title")`, which is
  // `typeof value === "string" ? value : ""` - so this is the same value by
  // the same rule, one layer up.
  //
  // The `try`/`catch` that used to wrap this is gone with the doc access: it
  // existed because `getMap` throws on a DESTROYED `Y.Doc`, and reading a
  // projected slice cannot. Keeping it would have been a guard against a
  // failure mode this line no longer has.
  // Guarded, and the guard is the POINT rather than defensiveness. The doc read
  // this replaced was total over any handle - `readMaybeString` answers `""`
  // for a missing key, and `getMap("epic")` creates the map if absent - so it
  // never depended on a complete projection. Three provider fixtures build a
  // partial `OpenEpicState` with no `epic` slice, and an unguarded read threw
  // on them: the VALUE substitution was exact, the TOTALITY was not.
  const epic: EpicHeader | undefined = handle.store.getState().epic;
  return typeof epic?.title === "string" ? epic.title : "";
}

/**
 * React-side hook that returns the current aggregated unsynced-edits map
 * from a registry. The snapshot reference is cached - if nothing has
 * changed (same entries and queue sizes), the prior reference is returned
 * so consumers subscribed via `useSyncExternalStore` do not re-render.
 */
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
