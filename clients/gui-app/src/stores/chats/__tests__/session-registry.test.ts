import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  ChatSessionRegistry,
  MAX_ACTIVE_CHAT_IDLE_DEFER_MS,
} from "@/stores/chats/session-registry";

const TTL_MS = 10 * 60 * 1_000;
// High enough that existing TTL-focused tests (≤2 sessions) never hit the cap.
const WARM_CAP = 8;
const SCOPE = "test-scope:user:host:transport";
const SCOPE_A = "test-scope:user:host:transport-a";
const SCOPE_B = "test-scope:user:host:transport-b";
const HOST = "host-1";
const HOST_B = "host-2";

function createHandle(epicId: string, chatId: string) {
  let closeCount = 0;
  return {
    handle: createChatSessionStore({
      hostId: "host-a",
      epicId,
      chatId,
      userId: null,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        close: () => {
          closeCount += 1;
        },
      }),
    }),
    closeCount: () => closeCount,
  };
}

describe("ChatSessionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a lease-free session warm until the idle TTL elapses", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.release("epic-1", "chat-1", HOST);

    // Just below the TTL: still warm (websocket open), so a switch-back reuses
    // the loaded snapshot instead of re-subscribing.
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);

    // Past the TTL: dropped.
    vi.advanceTimersByTime(1);
    expect(owned.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();
  });

  it("re-acquiring before the TTL revives the session and cancels eviction", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.release("epic-1", "chat-1", HOST);

    vi.advanceTimersByTime(TTL_MS / 2);
    const revived = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => createHandle("epic-1", "chat-1").handle,
    );
    expect(revived).toBe(acquired);

    // The original eviction timer must not fire after the revive.
    vi.advanceTimersByTime(TTL_MS);
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);
  });

  it("never expires a leased session, however long it stays open", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );

    vi.advanceTimersByTime(TTL_MS * 10);
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).not.toBeNull();
  });

  // The headline of ticket 43. Two tiles, ONE (epic, chat), TWO hosts - which
  // is reachable in production (post-fork twins keep the source's chat id) and
  // trivially reachable in dev (`--adopt-store` copies one identity store onto
  // a second host). The pre-fix registry keyed entries on `epic:chat` only, so
  // the second `acquire` found the first host's entry, read a scope key that
  // legitimately differed (the scope carries the host), and DISPOSED a session
  // whose tile was still mounted and still holding the handle.
  it("does not dispose a live session when the same chat is opened on another host", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const onHostA = createHandle("epic-1", "chat-1");
    const onHostB = createHandle("epic-1", "chat-1");

    const handleA = registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: HOST,
        scopeKey: `${SCOPE}:${HOST}`,
      },
      () => onHostA.handle,
    );
    const handleB = registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: HOST_B,
        scopeKey: `${SCOPE}:${HOST_B}`,
      },
      () => onHostB.handle,
    );

    // Two distinct sessions, both live: the second open must not close the
    // first tile's websocket.
    expect(handleA).toBe(onHostA.handle);
    expect(handleB).toBe(onHostB.handle);
    expect(handleB).not.toBe(handleA);
    expect(onHostA.closeCount()).toBe(0);
    expect(onHostB.closeCount()).toBe(0);
    expect(registry.size()).toBe(2);

    // And each host's peek answers with ITS OWN session, never the other's.
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(handleA);
    expect(registry.peek("epic-1", "chat-1", HOST_B)).toBe(handleB);

    // Releasing one leaves the other leased and untouched: host A's tile
    // closes, host B's stays open past the idle TTL that would have expired an
    // unleased session.
    registry.releaseHandle("epic-1", "chat-1", HOST, handleA);
    vi.advanceTimersByTime(TTL_MS);
    expect(onHostA.closeCount()).toBe(1);
    expect(onHostB.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();
    expect(registry.peek("epic-1", "chat-1", HOST_B)).toBe(handleB);
  });

  // The other half of the same rule: within ONE host the old semantics are
  // unchanged - a same-scope re-acquire still dedups onto the live session,
  // and a genuine scope change (user / transport / owner-identity) still
  // rebuilds it in place.
  it("still dedups and still rebuilds on scope change within one host", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const original = createHandle("epic-1", "chat-1");
    const rebuilt = createHandle("epic-1", "chat-1");

    const first = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_A },
      () => original.handle,
    );
    const deduped = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_A },
      () => createHandle("epic-1", "chat-1").handle,
    );
    expect(deduped).toBe(first);
    expect(original.closeCount()).toBe(0);

    const replacement = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_B },
      () => rebuilt.handle,
    );
    expect(replacement).toBe(rebuilt.handle);
    expect(original.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(replacement);
  });

  it("reuses a same-scope session without recreating the stream client", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");
    const createFirst = vi.fn(() => owned.handle);
    const createReplacement = vi.fn(
      () => createHandle("epic-1", "chat-1").handle,
    );

    const first = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_A },
      createFirst,
    );
    const second = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_A },
      createReplacement,
    );

    expect(second).toBe(first);
    expect(createFirst).toHaveBeenCalledTimes(1);
    expect(createReplacement).not.toHaveBeenCalled();
    expect(owned.closeCount()).toBe(0);
  });

  it("recreates a session on scope change and ignores stale releases", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const oldTransport = createHandle("epic-1", "chat-1");
    const newTransport = createHandle("epic-1", "chat-1");

    const firstLease = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_A },
      () => oldTransport.handle,
    );
    const secondLease = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_A },
      () => createHandle("epic-1", "chat-1").handle,
    );
    const replacement = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE_B },
      () => newTransport.handle,
    );

    expect(secondLease).toBe(firstLease);
    expect(replacement).toBe(newTransport.handle);
    expect(replacement).not.toBe(firstLease);
    expect(oldTransport.closeCount()).toBe(1);
    expect(newTransport.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(replacement);

    registry.releaseHandle("epic-1", "chat-1", HOST, firstLease);
    registry.releaseHandle("epic-1", "chat-1", HOST, secondLease);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(replacement);
    expect(newTransport.closeCount()).toBe(0);

    registry.releaseHandle("epic-1", "chat-1", HOST, replacement);
    vi.advanceTimersByTime(TTL_MS);
    expect(newTransport.closeCount()).toBe(1);
  });

  it("keeps a lease-free active turn past idle TTL, then evicts once settled", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");
    const hostIds = new WeakMap<object, string>();

    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    hostIds.set(acquired, "host-original");
    markRunning(acquired);

    // The tile lease can disappear during a transient offline/null directory
    // state. The active turn must keep the retained session handle alive past
    // the normal idle TTL instead of closing the GUI stream handle.
    registry.release("epic-1", "chat-1", HOST);
    vi.advanceTimersByTime(TTL_MS);

    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);

    // Same host becomes available again: re-opening revives the exact handle,
    // preserving any external host-id association for the bound chat tab.
    const revived = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => createHandle("epic-1", "chat-1").handle,
    );
    expect(revived).toBe(acquired);
    expect(hostIds.get(revived)).toBe("host-original");

    // Once the turn has settled and the tile unmounts again, idle eviction
    // returns to normal and the session is disposed after the TTL.
    revived.store.setState({
      runStatus: "idle",
      activeTurn: null,
    });
    registry.release("epic-1", "chat-1", HOST);
    vi.advanceTimersByTime(TTL_MS);

    expect(owned.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();
  });

  it("evicts a lease-free active session after the active defer cap", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    markRunning(acquired);

    registry.release("epic-1", "chat-1", HOST);
    vi.advanceTimersByTime(MAX_ACTIVE_CHAT_IDLE_DEFER_MS + TTL_MS);

    expect(owned.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();
  });

  it("restarts the idle window each time the session is re-opened", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.release("epic-1", "chat-1", HOST);
    vi.advanceTimersByTime(TTL_MS - 1);

    // Re-open + leave again just before expiry: the window resets.
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.release("epic-1", "chat-1", HOST);

    vi.advanceTimersByTime(TTL_MS - 1);
    expect(owned.closeCount()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(owned.closeCount()).toBe(1);
  });

  it("does not extend the idle window on a passive peek", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.release("epic-1", "chat-1", HOST);

    vi.advanceTimersByTime(TTL_MS - 1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(owned.handle);
    vi.advanceTimersByTime(1);
    expect(owned.closeCount()).toBe(1);
  });

  it("force-releases a kept-alive session unconditionally", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");

    registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.release("epic-1", "chat-1", HOST);
    expect(owned.closeCount()).toBe(0);

    registry.forceRelease("epic-1", "chat-1", HOST);
    expect(owned.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();

    // The cancelled timer must not double-dispose later.
    vi.advanceTimersByTime(TTL_MS);
    expect(owned.closeCount()).toBe(1);
  });

  it("caps lease-free warm sessions, disposing oldest-released first", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: 2,
    });
    const a = createHandle("epic-1", "chat-a");
    const b = createHandle("epic-1", "chat-b");
    const c = createHandle("epic-1", "chat-c");
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-a", hostId: HOST, scopeKey: SCOPE },
      () => a.handle,
    );
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-b", hostId: HOST, scopeKey: SCOPE },
      () => b.handle,
    );
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-c", hostId: HOST, scopeKey: SCOPE },
      () => c.handle,
    );

    registry.release("epic-1", "chat-a", HOST);
    vi.advanceTimersByTime(1_000);
    registry.release("epic-1", "chat-b", HOST);
    vi.advanceTimersByTime(1_000);
    // Two warm sessions: exactly at the cap, nothing evicted yet.
    expect(a.closeCount()).toBe(0);
    expect(b.closeCount()).toBe(0);

    // A third release overflows the cap; the oldest-released (a) goes.
    registry.release("epic-1", "chat-c", HOST);
    expect(a.closeCount()).toBe(1);
    expect(b.closeCount()).toBe(0);
    expect(c.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-a", HOST)).toBeNull();
    expect(registry.peek("epic-1", "chat-b", HOST)).toBe(b.handle);
    expect(registry.peek("epic-1", "chat-c", HOST)).toBe(c.handle);
  });

  it("does not evict lease-free active sessions to satisfy the warm cap", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: 2,
    });
    const active = createHandle("epic-1", "chat-active");
    const b = createHandle("epic-1", "chat-b");
    const c = createHandle("epic-1", "chat-c");
    registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-active",
        hostId: HOST,
        scopeKey: SCOPE,
      },
      () => active.handle,
    );
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-b", hostId: HOST, scopeKey: SCOPE },
      () => b.handle,
    );
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-c", hostId: HOST, scopeKey: SCOPE },
      () => c.handle,
    );

    markRunning(active.handle);

    registry.release("epic-1", "chat-active", HOST);
    vi.advanceTimersByTime(1_000);
    registry.release("epic-1", "chat-b", HOST);
    vi.advanceTimersByTime(1_000);
    registry.release("epic-1", "chat-c", HOST);

    expect(active.closeCount()).toBe(0);
    expect(b.closeCount()).toBe(1);
    expect(c.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-active", HOST)).toBe(active.handle);
    expect(registry.peek("epic-1", "chat-b", HOST)).toBeNull();
    expect(registry.peek("epic-1", "chat-c", HOST)).toBe(c.handle);
  });

  it("never evicts leased sessions to satisfy the warm cap", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: 1,
    });
    const leased = createHandle("epic-1", "chat-a");
    const b = createHandle("epic-1", "chat-b");
    const c = createHandle("epic-1", "chat-c");
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-a", hostId: HOST, scopeKey: SCOPE },
      () => leased.handle,
    );
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-b", hostId: HOST, scopeKey: SCOPE },
      () => b.handle,
    );
    registry.acquire(
      { epicId: "epic-1", chatId: "chat-c", hostId: HOST, scopeKey: SCOPE },
      () => c.handle,
    );

    registry.release("epic-1", "chat-b", HOST);
    vi.advanceTimersByTime(1_000);
    registry.release("epic-1", "chat-c", HOST);

    // Warm cap of 1: b (older warm) is evicted, c kept, the leased session
    // untouched no matter how the cap is squeezed.
    expect(leased.closeCount()).toBe(0);
    expect(b.closeCount()).toBe(1);
    expect(c.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-a", HOST)).toBe(leased.handle);
  });

  it("notifies subscribers when sessions appear and expire", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => createHandle("epic-1", "chat-1").handle,
    );
    expect(listener).toHaveBeenCalledTimes(1);

    registry.release("epic-1", "chat-1", HOST);
    vi.advanceTimersByTime(TTL_MS);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.acquire(
      { epicId: "epic-2", chatId: "chat-2", hostId: HOST, scopeKey: SCOPE },
      () => createHandle("epic-2", "chat-2").handle,
    );
    registry.disposeAll();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("membershipIdsForHost lists session keys of that host only", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });

    registry.acquire(
      { epicId: "epic-1", chatId: "chat-a", hostId: HOST, scopeKey: SCOPE },
      () => createHandle("epic-1", "chat-a").handle,
    );
    registry.acquire(
      { epicId: "epic-2", chatId: "chat-b", hostId: HOST_B, scopeKey: SCOPE },
      () => createHandle("epic-2", "chat-b").handle,
    );

    const hostA = registry.membershipIdsForHost(HOST);
    const hostB = registry.membershipIdsForHost(HOST_B);
    expect(hostA).toHaveLength(1);
    expect(hostB).toHaveLength(1);
    expect(hostA[0]).not.toBe(hostB[0]);
    expect(registry.membershipIdsForHost("host-none")).toEqual([]);
    registry.disposeAll();
  });
});

function markRunning(handle: ChatSessionStoreHandle): void {
  handle.store.setState({
    runStatus: "running",
    activeTurn: {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 1,
      updatedAt: 1,
      reasoningEffort: null,
      serviceTier: null,
    },
  });
}
