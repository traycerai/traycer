import {
  isChatRunInProgress,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

interface RegistryEntry {
  readonly key: string;
  readonly scopeKey: string;
  readonly handle: ChatSessionStoreHandle;
  leases: number;
  lastUsedAt: number;
  idleStartedAt: number | null;
  /**
   * Pending idle-eviction timer, set only while the entry is lease-free.
   * Browser `setTimeout` returns `number`; cleared (and nulled) the moment
   * the entry is re-leased, touched, or torn down.
   */
  idleTimer: number | null;
}

/**
 * How long a chat session is kept warm after its last tile unmounts. A chat
 * not re-opened within this window has its `chat.subscribe` websocket closed
 * and its snapshot dropped; re-opening it later re-subscribes (and shows the
 * usual loading state once). Switching back inside the window is instant.
 */
export const DEFAULT_CHAT_IDLE_TTL_MS = 10 * 60 * 1_000;
export const MAX_ACTIVE_CHAT_IDLE_DEFER_MS = 60 * 60 * 1_000;

/**
 * Upper bound on inactive lease-free warm sessions held at once. The idle TTL
 * bounds retention in time; this bounds it in count, so cycling through many
 * chats inside one TTL window cannot pin an unbounded set of finished
 * transcripts and open websockets. Oldest-released inactive sessions are
 * disposed first. Leased sessions are outside the warm pool. Lease-free
 * sessions with active chat work are never evicted by the cap, but they still
 * contribute to overflow and can crowd out older inactive warm sessions.
 */
export const DEFAULT_MAX_WARM_CHAT_SESSIONS = 6;

export interface ChatSessionRegistryOptions {
  readonly idleTtlMs: number;
  readonly maxWarmSessions: number;
}

/**
 * Small per-renderer registry for live `chat.subscribe` sessions. It mirrors
 * the open-Epic registry shape, but chat tiles are lease-counted because the
 * same chat can be rendered by more than one surface in a window.
 *
 * Time-based keep-alive: when a chat's last lease is dropped (its tile
 * unmounts on a tab switch) the session is NOT torn down. Its websocket stays
 * open and its loaded snapshot is retained so switching back paints instantly
 * - no reconnect, no loading spinner. A lease-free ("idle") session is held
 * until it goes untouched for `idleTtlMs`, at which point it is disposed.
 * Re-opening or otherwise touching the session resets that window. Leased
 * sessions (a currently-rendered tile) never expire - only the idle clock
 * runs - so a window with many open chat tiles keeps them all. Inactive idle
 * sessions are additionally count-bounded by `maxWarmSessions`
 * (oldest-released evicted first) so the TTL window alone cannot accumulate an
 * unbounded set. Idle sessions with active work are retained until the work
 * settles or the active defer cap elapses, though they still contribute to the
 * overflow count while selecting inactive eviction candidates.
 */
export class ChatSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly idleTtlMs: number;
  private readonly maxWarmSessions: number;

  constructor(options: ChatSessionRegistryOptions) {
    this.idleTtlMs = options.idleTtlMs;
    this.maxWarmSessions = options.maxWarmSessions;
  }

  size(): number {
    return this.entries.size;
  }

  get(
    epicId: string,
    chatId: string,
    scopeKey: string,
  ): ChatSessionStoreHandle | null {
    const entry = this.entries.get(chatSessionKey(epicId, chatId));
    if (entry === undefined) return null;
    if (entry.scopeKey !== scopeKey) return null;
    this.touch(entry);
    return entry.handle;
  }

  peek(epicId: string, chatId: string): ChatSessionStoreHandle | null {
    return this.entries.get(chatSessionKey(epicId, chatId))?.handle ?? null;
  }

  /** Live session handles, for aggregate reads (e.g. agent-activity). */
  listHandles(): ChatSessionStoreHandle[] {
    return Array.from(this.entries.values(), (entry) => entry.handle);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  acquire(
    epicId: string,
    chatId: string,
    scopeKey: string,
    factory: (epicId: string, chatId: string) => ChatSessionStoreHandle,
  ): ChatSessionStoreHandle {
    const key = chatSessionKey(epicId, chatId);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.scopeKey !== scopeKey) {
        // The chat id is the same, but the session was opened against an older
        // user/host/transport scope. Close it before creating the replacement
        // so callers never get a store backed by a stale ChatStreamClient.
        this.disposeEntry(existing);
      } else {
        // Revives an idle (lease-free) session in place - the websocket and
        // loaded snapshot carry over, so the caller sees no reconnect. Holding
        // a lease cancels any pending idle eviction.
        existing.leases += 1;
        existing.lastUsedAt = now();
        existing.idleStartedAt = null;
        this.clearIdleTimer(existing);
        return existing.handle;
      }
    }
    const handle = factory(epicId, chatId);
    this.entries.set(key, {
      key,
      scopeKey,
      handle,
      leases: 1,
      lastUsedAt: now(),
      idleStartedAt: null,
      idleTimer: null,
    });
    this.notify();
    return handle;
  }

  release(epicId: string, chatId: string): void {
    const key = chatSessionKey(epicId, chatId);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.releaseEntry(entry);
  }

  releaseHandle(
    epicId: string,
    chatId: string,
    handle: ChatSessionStoreHandle,
  ): void {
    const entry = this.entries.get(chatSessionKey(epicId, chatId));
    if (entry === undefined || entry.handle !== handle) return;
    this.releaseEntry(entry);
  }

  private releaseEntry(entry: RegistryEntry): void {
    // Refcount underflow guard: a stray double-release must not drive `leases`
    // negative, which a later `acquire` would revive only to 0 - leaving an
    // in-use session tracked as idle and eligible for eviction.
    if (entry.leases <= 0) return;
    entry.leases -= 1;
    if (entry.leases > 0) return;
    // Last lease gone: keep the session warm and start the idle clock. It is
    // disposed if nothing re-opens it before `idleTtlMs` elapses.
    const releasedAt = now();
    entry.lastUsedAt = releasedAt;
    entry.idleStartedAt = releasedAt;
    this.scheduleIdleEviction(entry);
    this.evictWarmOverflow();
  }

  forceRelease(epicId: string, chatId: string): void {
    const entry = this.entries.get(chatSessionKey(epicId, chatId));
    if (entry === undefined) return;
    this.disposeEntry(entry);
    this.notify();
  }

  disposeAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      this.clearIdleTimer(entry);
      entry.handle.dispose();
    }
    this.entries.clear();
    this.notify();
  }

  /**
   * Marks an entry as just-accessed: refreshes recency and, if it is idle,
   * restarts its eviction window. `peek` deliberately does not touch, so a
   * passive reader (e.g. the sidebar progress icon) cannot keep a session
   * alive forever.
   */
  private touch(entry: RegistryEntry): void {
    const touchedAt = now();
    entry.lastUsedAt = touchedAt;
    if (entry.leases === 0) entry.idleStartedAt = touchedAt;
    if (entry.leases === 0) this.scheduleIdleEviction(entry);
  }

  private scheduleIdleEviction(entry: RegistryEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = window.setTimeout(() => {
      this.evictIfIdle(entry.key);
    }, this.idleTtlMs);
  }

  /** Single teardown path for one entry; callers own the `notify()`. */
  private disposeEntry(entry: RegistryEntry): void {
    this.clearIdleTimer(entry);
    this.entries.delete(entry.key);
    entry.handle.dispose();
  }

  /**
   * Enforces the warm cap after a release transitions an entry to lease-free.
   * Only inactive lease-free entries are candidates; the oldest-released go
   * first. Active lease-free sessions stay retained so passive tab/header
   * progress readers still have the `runStatus` snapshot after a tile unmounts.
   */
  private evictWarmOverflow(): void {
    // Total size bounds the idle count, so an under-cap registry skips the
    // filter/sort entirely - the common case on every release.
    if (this.entries.size <= this.maxWarmSessions) return;
    const idle = Array.from(this.entries.values()).filter(
      (entry) => entry.leases === 0,
    );
    const overflow = idle.length - this.maxWarmSessions;
    if (overflow <= 0) return;
    const candidates = idle.filter((entry) => !hasActiveChatWork(entry.handle));
    candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const evicted = candidates.slice(0, overflow);
    for (const entry of evicted) {
      this.disposeEntry(entry);
    }
    if (evicted.length === 0) return;
    this.notify();
  }

  private evictIfIdle(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    if (entry.leases > 0) return;
    const checkedAt = now();
    if (checkedAt - entry.lastUsedAt < this.idleTtlMs) return;
    if (hasActiveChatWork(entry.handle)) {
      const idleStartedAt = entry.idleStartedAt ?? entry.lastUsedAt;
      if (checkedAt - idleStartedAt < MAX_ACTIVE_CHAT_IDLE_DEFER_MS) {
        entry.lastUsedAt = checkedAt;
        this.scheduleIdleEviction(entry);
        return;
      }
    }
    this.disposeEntry(entry);
    this.notify();
  }

  private clearIdleTimer(entry: RegistryEntry): void {
    if (entry.idleTimer === null) return;
    window.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

function now(): number {
  return Date.now();
}
function chatSessionKey(epicId: string, chatId: string): string {
  return `${epicId}:${chatId}`;
}

function hasActiveChatWork(handle: ChatSessionStoreHandle): boolean {
  const state = handle.store.getState();
  // A chat parked on a human gate (interview / command approval / file-edit
  // approval) is in progress - the turn is blocked on the user, not finished.
  // Count it as active work so the warm-chat idle TTL and the warm-overflow cap
  // do not dispose its `chat.subscribe` stream while the user is still expected
  // to answer (the host holds its session alive in the same situation).
  return (
    state.activeTurn !== null ||
    isChatRunInProgress(state.runStatus) ||
    state.pendingApprovals.length > 0 ||
    state.pendingFileEditApprovals.length > 0 ||
    state.pendingInterviews.length > 0
  );
}
