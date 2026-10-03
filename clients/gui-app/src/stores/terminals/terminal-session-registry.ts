import {
  createSessionRegistry,
  type SessionRegistry,
} from "@traycer-clients/shared/replica-runtime";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import {
  DESKTOP_RETENTION_PROFILE,
  getRetentionProfile,
} from "@/stores/replica-memory/retention-profile";
import type { TerminalSubscribeViewer } from "@traycer/protocol/host/terminal/subscribe";
import type {
  TerminalSessionState,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";

/**
 * How long a released, still-running terminal keeps its handle (and
 * therefore its live `terminal.subscribe` stream + warm xterm engine) before
 * the registry evicts it. Navigating away from the surface that mounted the
 * tile (landing page -> epic tab, epic -> epic) releases every lease; without
 * this window the stream is torn down immediately and coming back pays the
 * full reconnect cost - transport dial, re-subscribe, snapshot replay - as
 * seconds of blank terminal. Within the window a remount reacquires the same
 * handle and reattaches the same engine instantly. The host-side PTY runs
 * regardless; this only bounds how long the renderer keeps an attachment
 * nobody is looking at. Matches `DEFAULT_CHAT_IDLE_TTL_MS` so a tab switch
 * treats the chats and the terminals it hides identically.
 */
export const PLAIN_TERMINAL_RELEASE_LINGER_MS = 10 * 60 * 1000;

/**
 * Upper bound on lease-free terminal attachments, shells and agents alike.
 * Oldest-released first; leased views never enter this pool. The host keeps
 * the PTY and its snapshot buffer alive after renderer attachment eviction.
 */
export const MAX_LINGERING_PLAIN_TERMINALS =
  DESKTOP_RETENTION_PROFILE.maxLingeringPlainTerminals;

/**
 * Owner-scoped identity for warm-presentation lookup. Terminal sessions
 * always carry the bound owner `hostId`. `hostId: null` is the explicit
 * hostless/non-terminal compatibility path — never inferred from the
 * active or serving host.
 */
export type TerminalWarmSessionIdentity = {
  readonly hostId: string | null;
  readonly sessionId: string;
};

/**
 * What this registry holds per tab instance: the handle, the owner host it was
 * acquired for, and the status subscription that evicts it once the session
 * becomes unreattachable.
 *
 * A record rather than the bare handle because the host is ACQUIRE-TIME
 * identity that the handle does not carry, and it has to live in the same book
 * as the entry it describes - a parallel `Map<instanceId, hostId>` is two
 * records of one fact, free to disagree the moment an entry is rekeyed or
 * evicted through a path that forgets it.
 *
 * It is deliberately NOT folded into the entry KEY (which is the tab instance
 * id alone): a different host under the same instance id would then read as a
 * different session, and the incumbent registry treats the host passed to a
 * repeat `acquire` as ignorable rather than as grounds for a rebuild.
 */
interface TerminalRegistrySession {
  readonly handle: TerminalSessionStoreHandle;
  /** Bound owner host. `null` is the explicit hostless path. */
  readonly hostId: string | null;
  /**
   * Reaped and re-created on a rekey: the closure captures the instance id, so
   * a subscription left under the old key would target an entry that no longer
   * exists and the defunct handle would never be evicted.
   */
  unsubscribeStatus: () => void;
}

/**
 * Every terminal entry shares one scope. The registry's scope key
 * discriminates REBUILDS within one identity, and this plane has no such
 * axis: a tab instance id names one session for its whole life, and the host
 * it is bound to is data on the entry rather than a rebuild trigger.
 */
const TERMINAL_SESSION_SCOPE = "terminal";

/**
 * Per-renderer registry for live `terminal.subscribe` sessions, lease-counted
 * so the same tab instance can mount in more than one place (a split-reparent
 * transition, StrictMode double-mount) without each remount tearing down the
 * underlying stream client. Mirrors `ChatSessionRegistry` in shape, scoped to a
 * single window - and now literally shares its mechanism: both, and the
 * open-epic registry, run on {@link createSessionRegistry}, with the three
 * policies that used to be three implementations expressed as this plane's
 * answers below.
 *
 * Entries are keyed by the per-tab `instanceId`, not the host `sessionId`, so
 * two tab instances of the SAME PTY/TUI session each get their own handle and
 * their own `TerminalStreamClient` subscribing to the shared session. The
 * host already fans `terminal.subscribe` out to many subscribers and replays
 * scrollback to each, so a second live view costs nothing host-side.
 *
 * Lease-free running sessions linger for
 * {@link PLAIN_TERMINAL_RELEASE_LINGER_MS}, count-bounded by
 * {@link MAX_LINGERING_PLAIN_TERMINALS} (oldest-released first). Exited,
 * lost and reaped sessions are disposed as soon as the last lease releases.
 * Unacknowledged writes protect a live or lost handle until replay settles;
 * they exist only in the renderer, unlike the host's output snapshot.
 */
export class TerminalSessionRegistry {
  private readonly sessions: SessionRegistry<TerminalRegistrySession>;
  /**
   * The intent of the `acquire` in progress, for `onRevived`: the shared
   * registry revives inside `acquire` and hands its policy the session only.
   */
  private acquiringViewer: TerminalSubscribeViewer = "presentation";

  constructor() {
    this.sessions = createSessionRegistry<TerminalRegistrySession>({
      environment: createRendererRuntimeEnvironment(),
      policy: {
        idleTtlMs: PLAIN_TERMINAL_RELEASE_LINGER_MS,
        // The shell's retention profile (desktop:
        // `MAX_LINGERING_PLAIN_TERMINALS`), read on every cap walk.
        get maxWarm(): number {
          return getRetentionProfile().maxLingeringPlainTerminals;
        },
        warmCapScope: "demand-free",
        busyCountsTowardWarmCap: true,
        maxActiveDeferMs: null,
        // Ordered by release, which is what `releaseSequence` recorded.
        refreshOrderOnRelease: true,
        retainWhenIdle: ({ handle }) => shouldLingerLeaseFree(handle),
        // Unacked writes retain the handle without a time bound until ack,
        // exit or explicit teardown; never silently expire input. Follow-ups:
        // bounded retention with surfaced discard, and recovery handoff.
        hasActiveWork: ({ handle }) =>
          hasPendingWrites(handle.store.getState()),
        activeWorkReason: () => "unacknowledged-input",
        // The shared cap already checks hasActiveWork; idle expiry does too.
        isEvictable: () => true,
        onBeforeDispose: () => "dispose",
        dispose: (session) => {
          session.unsubscribeStatus();
          session.handle.dispose();
        },
        // Attachment intent follows lease state, not session kind: a
        // lease-free running terminal-agent or
        // lingering plain terminal must not claim attention.
        // A lease change reopens the stream as `cache`, which is how a host
        // of any version hears it. A THROW here is the disappearing-transport
        // case and the registry fails toward disposal, because the captured
        // factory throws when the directory or user is gone and a warm entry
        // whose stream is already closed would only ever be revived dead.
        onParked: ({ handle }) => {
          handle.store.getState().setViewer("cache");
        },
        // Lease-free keep-warm / linger was tagged `cache`. The tile taking
        // the lease states what it is: one on screen is `presentation`, which
        // reopens the stream; one mounted off screen stays `cache`, which
        // leaves the parked stream exactly as it is.
        onRevived: ({ handle }) => {
          handle.store.getState().setViewer(this.acquiringViewer);
        },
      },
    });
  }

  size(): number {
    return this.sessions.size();
  }

  /**
   * Subscribe to membership changes (an instance added or removed). Mirrors
   * `ChatSessionRegistry.subscribe`. Per-session lifecycle-status changes are
   * observed by subscribing to each handle's store, not here. The
   * agent-activity monitor uses this to keep its per-store subscriptions in
   * sync as terminal tiles mount and unmount.
   */
  subscribe(listener: () => void): () => void {
    return this.sessions.subscribe(listener);
  }

  /** Live session handles, for aggregate reads (e.g. agent-activity). */
  listHandles(): TerminalSessionStoreHandle[] {
    return this.sessions.list().map((session) => session.handle);
  }

  /**
   * Live tab-instance ids bound to one host. Overview's `host.status`
   * refresh uses this so a membership change on host B does not void
   * host A's settled busy. Reads the acquire-time identity, not the WeakMap
   * the React hook stamps — that map is only set by
   * `useTerminalSessionHandle`.
   */
  membershipIdsForHost(hostId: string): string[] {
    const ids: string[] = [];
    for (const entry of this.sessions.entries()) {
      if (entry.session.hostId !== hostId) continue;
      ids.push(entry.key);
    }
    ids.sort();
    return ids;
  }

  /**
   * Live tab-instance ids. The xterm host registry keeps still-live
   * terminal-agent engines warm keyed by `instanceId`; it uses this to drop a
   * warm engine once its lease-free handle exits, expires or exceeds the cap.
   */
  listInstanceIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  get(instanceId: string): TerminalSessionStoreHandle | null {
    // `peek`, not `get`: this plane has never refreshed recency on a read, and
    // its eviction order is the release order rather than a last-used one.
    return this.sessions.peek(instanceId)?.handle ?? null;
  }

  /**
   * `viewer` is the acquiring tile's attachment intent. It decides what a
   * revived lease-free entry becomes; a fresh store takes its own from
   * `factory`.
   */
  acquire(
    instanceId: string,
    factory: () => TerminalSessionStoreHandle,
    hostId: string | null,
    viewer: TerminalSubscribeViewer,
  ): TerminalSessionStoreHandle {
    this.acquiringViewer = viewer;
    return this.sessions.acquire(instanceId, TERMINAL_SESSION_SCOPE, () => {
      const handle = factory();
      return {
        handle,
        hostId,
        unsubscribeStatus: this.watchDefunct(instanceId, handle),
      };
    }).handle;
  }

  /**
   * Subscribe the handle's store for defunct-state eviction of the entry at
   * `instanceId`. Extracted because a rekey ({@link rekeyLeaseFreeEntry})
   * must re-subscribe under the new instance id - the closure captures the
   * id, so the old subscription would target a key that no longer exists and
   * the defunct handle would never be evicted.
   */
  private watchDefunct(
    instanceId: string,
    handle: TerminalSessionStoreHandle,
  ): () => void {
    return handle.store.subscribe((state, previous) => {
      const defunct =
        state.status === "exited" ||
        // `TERMINAL_NOT_FOUND` only proves this handle's PTY is gone. A
        // durable terminal may already have been recreated under the same
        // logical id, so a reaped handle must never shadow a fresh bootstrap.
        state.status === "reaped" ||
        // A lost handle may still owe input replay to the live host PTY.
        (state.status === "lost" && !hasPendingWrites(state));
      if (defunct) {
        this.evictDefunctLeaseFreeEntry(instanceId);
      } else if (
        state.pendingActions !== previous.pendingActions &&
        hasPendingWrites(previous) &&
        !hasPendingWrites(state)
      ) {
        this.sessions.reevaluate(instanceId);
      }
    });
  }

  /**
   * A lease-free warm entry for `sessionId` that a NEW tab instance may adopt
   * ({@link rekeyLeaseFreeEntry}). Closing a tab keeps a running session's
   * handle warm, but reopening mints a fresh tab instance id - without
   * adoption the reopened tile would build a SECOND subscription while the
   * warm one lingers as an unreachable zombie (still attached host-side,
   * with no UI able to reach it). Returns null when the session has no warm lease-free entry or the
   * new id is already registered (remount, StrictMode second pass).
   */
  findAdoptableInstanceId(
    identity: TerminalWarmSessionIdentity,
    newInstanceId: string,
  ): string | null {
    if (this.sessions.peekEntry(newInstanceId) !== null) return null;
    for (const entry of this.sessions.entries()) {
      if (entry.session.handle.sessionId !== identity.sessionId) continue;
      if (entry.session.hostId !== identity.hostId) continue;
      if (entry.demand > 0) continue;
      if (entry.session.handle.store.getState().status === "reaped") continue;
      return entry.key;
    }
    return null;
  }

  /**
   * Rekey a lease-free entry to a new tab instance id so a reopened tab
   * revives the closed tab's warm handle (live stream, current scrollback)
   * instead of duplicating the subscription. The caller must rekey the xterm
   * engine registry FIRST: this notify wakes the engine follower, which
   * disposes engines whose instance id is no longer a registry member.
   */
  rekeyLeaseFreeEntry(oldInstanceId: string, newInstanceId: string): boolean {
    const entry = this.sessions.peekEntry(oldInstanceId);
    if (entry === null) return false;
    const session = entry.session;
    return this.sessions.transact(() => {
      // Reaped before the move, so the surviving subscription is never the one
      // that names the old key. Re-armed under whichever key the entry ends up
      // at, including when the move loses its race.
      session.unsubscribeStatus();
      const moved = this.sessions.rekey(oldInstanceId, newInstanceId);
      session.unsubscribeStatus = this.watchDefunct(
        moved ? newInstanceId : oldInstanceId,
        session.handle,
      );
      return moved;
    });
  }

  /**
   * Drop one lease. `transportAlive` is the acquire effect's readiness at
   * cleanup time (directory entry + signed-in user still present). A last
   * lease with a live transport retags the keep-warm / linger subscribe as
   * `cache`. A disappearing transport must not reopen: the captured factory
   * throws when the directory or user is gone, and a throw from effect
   * cleanup would leave a lease-free entry whose old stream is already
   * closed. Fail toward disposal instead.
   */
  release(
    instanceId: string,
    handle: TerminalSessionStoreHandle,
    transportAlive: boolean,
  ): void {
    const entry = this.sessions.peekEntry(instanceId);
    if (entry === null) return;
    // A defunct handle may be replaced while an older consumer is still
    // mounted. Its eventual effect cleanup must not release a lease belonging
    // to the replacement incarnation now registered under the same instance.
    if (entry.session.handle !== handle) return;
    this.sessions.release(instanceId, transportAlive ? "warm" : "dispose");
  }

  forceRelease(instanceId: string): void {
    this.sessions.forceRelease(instanceId);
  }

  disposeAll(): void {
    this.sessions.disposeAll();
  }

  /**
   * Drops a lease-free entry whose session exited or stream closed for good.
   * Leased entries are left alone: the mounted tile observes the same status and owns the response
   * (close the tab, run recovery).
   */
  private evictDefunctLeaseFreeEntry(instanceId: string): void {
    const entry = this.sessions.peekEntry(instanceId);
    if (entry === null) return;
    if (entry.demand > 0) return;
    this.sessions.discard(instanceId, "unusable");
  }
}

/** Reopening either session kind replays the host's authoritative snapshot. */
function shouldLingerLeaseFree(handle: TerminalSessionStoreHandle): boolean {
  const state = handle.store.getState();
  return (
    state.status !== "exited" &&
    state.status !== "reaped" &&
    (state.status !== "lost" || hasPendingWrites(state))
  );
}

function hasPendingWrites(state: TerminalSessionState): boolean {
  return Object.values(state.pendingActions).some(
    (pending) => pending.frame.kind === "write",
  );
}
