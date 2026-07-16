import type { TerminalSessionStoreHandle } from "@/stores/terminals/terminal-session-store";

/**
 * How long a released, still-running plain terminal keeps its handle (and
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
 * Upper bound on lease-free lingering plain terminals held at once. The
 * linger window bounds retention in time; this bounds it in count, so cycling
 * through many terminal-bearing tabs inside one window cannot pin an unbounded
 * set of open streams and warm xterm engines. Oldest-released first. The
 * count-bounded pool is the lingering plain terminals only: lease-free
 * running terminal-agents live under their own indefinite keep-warm rule and
 * neither count toward nor get evicted by this cap (counting them would let N
 * running agents flush every lingering shell immediately). Mirrors
 * `DEFAULT_MAX_WARM_CHAT_SESSIONS`.
 */
export const MAX_LINGERING_PLAIN_TERMINALS = 6;

interface RegistryEntry {
  readonly instanceId: string;
  readonly handle: TerminalSessionStoreHandle;
  readonly unsubscribeStatus: () => void;
  leases: number;
  /** Pending timed eviction for a lease-free, still-running plain terminal. */
  lingerTimer: number | null;
  /**
   * Monotonic release ordinal, orders warm-cap eviction (oldest first).
   * `Date.now()` is not fine-grained enough - two releases in the same
   * synchronous batch (e.g. `closeAllTabs`) can land on the same millisecond,
   * making the sort order ambiguous - so a per-registry counter is used
   * instead.
   */
  releaseSequence: number;
}

/**
 * Per-renderer registry for live `terminal.subscribe` sessions, lease-counted
 * so the same tab instance can mount in more than one place (a split-reparent
 * transition, StrictMode double-mount) without each remount tearing down the
 * underlying stream client. Mirrors `ChatSessionRegistry` in shape, scoped to a
 * single window.
 *
 * Entries are keyed by the per-tab `instanceId`, not the host `sessionId`, so
 * two tab instances of the SAME PTY/TUI session each get their own handle and
 * their own `TerminalStreamClient` subscribing to the shared session. The
 * host already fans `terminal.subscribe` out to many subscribers and replays
 * scrollback to each, so a second live view costs nothing host-side.
 *
 * Lease-free retention: a running terminal-agent is kept warm indefinitely
 * (its tab may reopen any time while the agent works); a running plain
 * terminal lingers for {@link PLAIN_TERMINAL_RELEASE_LINGER_MS} so a tab
 * switch away and back reattaches instantly, count-bounded by
 * {@link MAX_LINGERING_PLAIN_TERMINALS} (oldest-released evicted first);
 * exited sessions are disposed as soon as the last lease releases. This is
 * the terminal twin of `ChatSessionRegistry`'s warm pool, so hiding a tab
 * treats its chats and terminals identically.
 */
export class TerminalSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();
  private nextReleaseSequence = 0;

  size(): number {
    return this.entries.size;
  }

  /**
   * Subscribe to membership changes (an instance added or removed). Mirrors
   * `ChatSessionRegistry.subscribe`. Per-session lifecycle-status changes are
   * observed by subscribing to each handle's store, not here. The
   * agent-activity monitor uses this to keep its per-store subscriptions in
   * sync as terminal tiles mount and unmount.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  /** Live session handles, for aggregate reads (e.g. agent-activity). */
  listHandles(): TerminalSessionStoreHandle[] {
    return Array.from(this.entries.values(), (entry) => entry.handle);
  }

  /**
   * Live tab-instance ids. The xterm host registry keeps still-live
   * terminal-agent engines warm keyed by `instanceId`; it uses this to drop a
   * warm engine once its instance leaves the registry (the agent exited and its
   * lease-free handle was evicted).
   */
  listInstanceIds(): string[] {
    return Array.from(this.entries.keys());
  }

  get(instanceId: string): TerminalSessionStoreHandle | null {
    const entry = this.entries.get(instanceId);
    return entry === undefined ? null : entry.handle;
  }

  acquire(
    instanceId: string,
    factory: () => TerminalSessionStoreHandle,
  ): TerminalSessionStoreHandle {
    const existing = this.entries.get(instanceId);
    if (existing !== undefined) {
      this.cancelLinger(existing);
      existing.leases += 1;
      return existing.handle;
    }
    const handle = factory();
    const entry: RegistryEntry = {
      instanceId,
      handle,
      unsubscribeStatus: handle.store.subscribe((state) => {
        const defunct =
          state.status === "exited" ||
          // "Lost" (the store's mapping of a `closed` stream) is a dead end
          // for a plain terminal: the stream client never redials after
          // `closed` (transient drops surface as "reconnecting", not
          // "closed"), so a lingering lost handle would only ever be revived
          // as a permanently dead store - and it would shadow the fresh
          // create-then-acquire bootstrap after the host recreates the
          // session. Lost terminal-AGENTS stay warm: their reopen path runs
          // `useTerminalSessionRecovery`, which force-releases the dead
          // handle and re-bootstraps.
          (state.status === "lost" && state.kind === "terminal");
        if (!defunct) return;
        this.evictDefunctLeaseFreeEntry(instanceId);
      }),
      leases: 1,
      lingerTimer: null,
      releaseSequence: 0,
    };
    this.entries.set(instanceId, entry);
    this.notify();
    return handle;
  }

  release(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return;
    if (entry.leases <= 0) return;
    entry.leases -= 1;
    if (entry.leases > 0) return;
    if (shouldKeepLeaseFree(entry.handle)) return;
    if (shouldLingerLeaseFree(entry.handle)) {
      // Still-running plain terminal: keep the handle (live stream + warm
      // engine) for the linger window so navigating back reattaches instantly
      // instead of paying a full reconnect. The entry stays a registry member
      // so the xterm follower keeps its engine; eviction happens on the timer,
      // on session exit or stream loss (the status subscription above), on
      // warm-cap overflow, or via forceRelease.
      entry.releaseSequence = this.nextReleaseSequence++;
      entry.lingerTimer = window.setTimeout(() => {
        entry.lingerTimer = null;
        if (entry.leases > 0) return;
        if (this.entries.get(instanceId) !== entry) return;
        this.entries.delete(instanceId);
        this.disposeEntry(entry);
        this.notify();
      }, PLAIN_TERMINAL_RELEASE_LINGER_MS);
      this.evictLingerOverflow();
      return;
    }
    this.entries.delete(instanceId);
    this.disposeEntry(entry);
    this.notify();
  }

  forceRelease(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return;
    this.entries.delete(instanceId);
    this.disposeEntry(entry);
    this.notify();
  }

  disposeAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.notify();
  }

  /**
   * Drops a lease-free entry whose session became unreattachable (exited, or
   * a plain terminal whose stream closed for good). Leased entries are left
   * alone: the mounted tile observes the same status and owns the response
   * (close the tab, run recovery).
   */
  private evictDefunctLeaseFreeEntry(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return;
    if (entry.leases > 0) return;
    this.entries.delete(instanceId);
    this.disposeEntry(entry);
    this.notify();
  }

  /**
   * Enforces the linger cap after a release parks an entry in the linger pool.
   * A live `lingerTimer` is the pool-membership marker, so lease-free warm
   * terminal-agents (timer-less) are neither counted nor candidates.
   */
  private evictLingerOverflow(): void {
    const lingering = Array.from(this.entries.values()).filter(
      (entry) => entry.lingerTimer !== null,
    );
    const overflow = lingering.length - MAX_LINGERING_PLAIN_TERMINALS;
    if (overflow <= 0) return;
    lingering.sort((a, b) => a.releaseSequence - b.releaseSequence);
    lingering.slice(0, overflow).forEach((entry) => {
      this.entries.delete(entry.instanceId);
      this.disposeEntry(entry);
    });
    this.notify();
  }

  private disposeEntry(entry: RegistryEntry): void {
    this.cancelLinger(entry);
    entry.unsubscribeStatus();
    entry.handle.dispose();
  }

  private cancelLinger(entry: RegistryEntry): void {
    if (entry.lingerTimer === null) return;
    window.clearTimeout(entry.lingerTimer);
    entry.lingerTimer = null;
  }
}

function shouldKeepLeaseFree(handle: TerminalSessionStoreHandle): boolean {
  const state = handle.store.getState();
  return state.kind === "terminal-agent" && state.status !== "exited";
}

/**
 * A released plain terminal lingers for
 * {@link PLAIN_TERMINAL_RELEASE_LINGER_MS} only while its stream can still
 * serve a reattach (creating/running). "Lost" is excluded: the stream client
 * never redials after `closed` (transient drops surface as "reconnecting"),
 * so a lost handle would be revived as a permanently dead terminal - the
 * landing tile has no recovery hook - and would shadow the fresh
 * create-then-acquire bootstrap after the host recreates the session.
 */
function shouldLingerLeaseFree(handle: TerminalSessionStoreHandle): boolean {
  const state = handle.store.getState();
  return (
    state.kind === "terminal" &&
    state.status !== "exited" &&
    state.status !== "lost"
  );
}
