import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { ChatSessionRegistry } from "@/stores/chats/session-registry";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
} from "@/stores/agent-activity-store";

// Mirrors `session-registry.test.ts`'s fixture shape (raw registry, no
// React). Owns the NEW `markTransient` / `markPresented` / `isTransient`
// surface `useChatSessionHandle` uses for cold-open admission (W3-A).
const TTL_MS = 10 * 60 * 1_000;
const WARM_CAP = 8;
const SCOPE = "test-scope:user:host:transport";
const HOST = "host-1";

function createHandle(epicId: string, chatId: string) {
  let closeCount = 0;
  return {
    handle: createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: "host-a",
      epicId,
      chatId,
      userId: null,
      onAuthError: null,
      onProviderAuthError: null,
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => {
          closeCount += 1;
        },
      }),
    }),
    closeCount: () => closeCount,
  };
}

/** A checkpoint restore still running - `hasUnsettledChatWork`'s own branch. */
function markRestoring(handle: ChatSessionStoreHandle): void {
  handle.store.setState({
    restore: {
      kind: "in-flight",
      checkpointId: "checkpoint-1",
      restoringUserId: "user-1",
      restoringHostId: "host-1",
      startedAt: 1,
      connectionEpoch: 0,
    },
  });
}

/** Mirrors `session-registry.test.ts`'s helper of the same name. */
function setLocalActivity(
  hostId: string,
  epicId: string,
  chatId: string,
  turn: boolean,
): void {
  __setHostAgentActivityHealthForTests(hostId, {
    connectionStatus: "open",
    servedBy: "local",
    cloudSyncStatus: null,
    stateFrameSeenThisEpoch: true,
  });
  __setHostAgentActivityStateForTests(
    hostId,
    { [epicId]: { working: [chatId], turn: turn ? [chatId] : [] } },
    "local",
    null,
  );
}

function setAccess(
  handle: ChatSessionStoreHandle,
  role: "owner" | "viewer",
): void {
  handle.store.setState({
    access: { role, ownerUserId: "owner-1", canAct: role === "owner" },
  });
}

describe("ChatSessionRegistry transient retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetAgentActivityStoreForTests();
    vi.useRealTimers();
  });

  it("discards a transient handle on release instead of parking it warm", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");
    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.markTransient(acquired);

    // A presented session survives its first release for the full idle TTL
    // (`session-registry.test.ts`'s "keeps a lease-free session warm..."). A
    // transient one, never shown, must not.
    registry.release("epic-1", "chat-1", HOST);

    expect(owned.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();
  });

  it("holds a shared transient handle through one holder's release, discarding only after the last", async () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");
    const target = {
      epicId: "epic-1",
      chatId: "chat-1",
      hostId: HOST,
      scopeKey: SCOPE,
    };
    const acquired = registry.acquire(target, () => owned.handle);
    registry.markTransient(acquired);
    registry.acquire(target, () => owned.handle); // second lease, same scope

    // `releaseHandle` queues a transient handle's decrement one microtask out
    // (StrictMode's cleanup/setup share one JS turn), but this is still not
    // the LAST holder - flushing that microtask must not touch it either.
    registry.releaseHandle("epic-1", "chat-1", HOST, acquired);
    await Promise.resolve();
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);

    registry.releaseHandle("epic-1", "chat-1", HOST, acquired);
    await Promise.resolve();
    expect(owned.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBeNull();
  });

  it("keeps a session warm through the ordinary idle TTL once markPresented lifts transience", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");
    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.markTransient(acquired);
    expect(registry.isTransient(acquired)).toBe(true);

    registry.markPresented(acquired);
    expect(registry.isTransient(acquired)).toBe(false);

    registry.release("epic-1", "chat-1", HOST);
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);

    vi.advanceTimersByTime(1);
    expect(owned.closeCount()).toBe(1);
  });

  it("keeps a transient handle mid checkpoint-restore alive past release, then discards it once the restore settles", () => {
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const owned = createHandle("epic-1", "chat-1");
    const acquired = registry.acquire(
      { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
      () => owned.handle,
    );
    registry.markTransient(acquired);
    markRestoring(acquired);

    // The checkpoint manifest frames are the only record of progress - a
    // naive "transient means discard on release" would drop it mid-flight.
    registry.release("epic-1", "chat-1", HOST);
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);

    vi.advanceTimersByTime(TTL_MS);
    expect(owned.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);

    acquired.store.setState({
      restore: {
        kind: "completed",
        checkpointId: "checkpoint-1",
        finishedAt: 2,
        results: [],
      },
    });
    vi.advanceTimersByTime(TTL_MS);
    expect(owned.closeCount()).toBe(1);
  });

  it("protects a transient handle mid checkpoint-restore from warm-cap eviction that chatCapHasActiveWork alone would miss", () => {
    // A checkpoint restore sets no `activeTurn`, approval, or queue item, so
    // `chatCapHasActiveWork` (the pre-existing warm-cap hold) answers `false`
    // for it. The sibling here is an ordinary PRESENTED (non-transient)
    // session, so the cap overflow is real: two warm entries over a cap of 1.
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: 1,
    });
    const restoring = createHandle("epic-1", "chat-restoring");
    const acquiredRestoring = registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-restoring",
        hostId: HOST,
        scopeKey: SCOPE,
      },
      () => restoring.handle,
    );
    registry.markTransient(acquiredRestoring);
    markRestoring(acquiredRestoring);

    const presented = createHandle("epic-1", "chat-presented");
    registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-presented",
        hostId: HOST,
        scopeKey: SCOPE,
      },
      () => presented.handle,
    );

    // Released oldest-first: without the transient-aware `hasActiveWork`
    // clause, the cap walk would treat the restoring session as idle (per
    // `chatCapHasActiveWork`) and evict IT first for being older.
    registry.release("epic-1", "chat-restoring", HOST);
    registry.release("epic-1", "chat-presented", HOST);

    expect(restoring.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-restoring", HOST)).toBe(
      acquiredRestoring,
    );
    expect(presented.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-presented", HOST)).toBeNull();
  });

  it("protects a transient handle mid checkpoint-restore from byte-budget eviction that chatCapHasActiveWork alone would miss", () => {
    // `evictOldestEligibleForByteBudget` has no prior direct coverage; the
    // hold here is `hasUnsettledChatWork` (restore.kind "in-flight"), the
    // same predicate the eligibility filter itself reads.
    const registry = new ChatSessionRegistry({
      idleTtlMs: TTL_MS,
      maxWarmSessions: WARM_CAP,
    });
    const restoring = createHandle("epic-1", "chat-restoring-budget");
    const acquiredRestoring = registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-restoring-budget",
        hostId: HOST,
        scopeKey: SCOPE,
      },
      () => restoring.handle,
    );
    registry.markTransient(acquiredRestoring);
    markRestoring(acquiredRestoring);

    // Still held (not yet released): the visible-transit shape a mounted
    // `useChatSessionHandle` produces while it awaits its snapshot. Nothing else is
    // acquired yet, so there is no eligible candidate at all.
    expect(registry.evictOldestEligibleForByteBudget()).toBe(false);
    expect(restoring.closeCount()).toBe(0);

    const presented = createHandle("epic-1", "chat-presented-budget");
    registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-presented-budget",
        hostId: HOST,
        scopeKey: SCOPE,
      },
      () => presented.handle,
    );

    registry.release("epic-1", "chat-restoring-budget", HOST);
    registry.release("epic-1", "chat-presented-budget", HOST);

    expect(registry.evictOldestEligibleForByteBudget()).toBe(true);
    expect(restoring.closeCount()).toBe(0);
    expect(registry.peek("epic-1", "chat-restoring-budget", HOST)).toBe(
      acquiredRestoring,
    );
    expect(presented.closeCount()).toBe(1);
    expect(registry.peek("epic-1", "chat-presented-budget", HOST)).toBeNull();
  });

  // A freshly cold-acquired transient handle has not loaded its own snapshot
  // yet, so `access` is `null` - not "viewer", not "owner", genuinely
  // unresolved. `hasActiveChatWork`'s host-activity-plane fallback currently
  // requires `access?.role === "owner"`, so it cannot see a turn the host is
  // ALREADY reporting for this chat before the chat's own subscribe confirms
  // ownership - a race a not-yet-subscribed acquisition makes reachable.
  describe("host activity plane, for a not-yet-resolved (access: null) transient handle", () => {
    const HOST_B = "host-2";

    it("keeps an untouched transient handle alive through release when its OWN host reports a turn", async () => {
      const registry = new ChatSessionRegistry({
        idleTtlMs: TTL_MS,
        maxWarmSessions: WARM_CAP,
      });
      const owned = createHandle("epic-1", "chat-1");
      const acquired = registry.acquire(
        { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
        () => owned.handle,
      );
      registry.markTransient(acquired);
      setLocalActivity(HOST, "epic-1", "chat-1", true);

      registry.releaseHandle("epic-1", "chat-1", HOST, acquired);
      await Promise.resolve();
      expect(owned.closeCount()).toBe(0);
      expect(registry.peek("epic-1", "chat-1", HOST)).toBe(acquired);
    });

    it("protects that same handle from warm-cap eviction, evicting an ordinary presented sibling instead", () => {
      const registry = new ChatSessionRegistry({
        idleTtlMs: TTL_MS,
        maxWarmSessions: 1,
      });
      const working = createHandle("epic-1", "chat-working");
      const acquiredWorking = registry.acquire(
        {
          epicId: "epic-1",
          chatId: "chat-working",
          hostId: HOST,
          scopeKey: SCOPE,
        },
        () => working.handle,
      );
      registry.markTransient(acquiredWorking);
      setLocalActivity(HOST, "epic-1", "chat-working", true);

      const presented = createHandle("epic-1", "chat-presented");
      registry.acquire(
        {
          epicId: "epic-1",
          chatId: "chat-presented",
          hostId: HOST,
          scopeKey: SCOPE,
        },
        () => presented.handle,
      );

      registry.release("epic-1", "chat-working", HOST);
      registry.release("epic-1", "chat-presented", HOST);

      expect(working.closeCount()).toBe(0);
      expect(registry.peek("epic-1", "chat-working", HOST)).toBe(
        acquiredWorking,
      );
      expect(presented.closeCount()).toBe(1);
    });

    it("still releases with no activity frame at all", () => {
      const registry = new ChatSessionRegistry({
        idleTtlMs: TTL_MS,
        maxWarmSessions: WARM_CAP,
      });
      const owned = createHandle("epic-1", "chat-1");
      const acquired = registry.acquire(
        { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
        () => owned.handle,
      );
      registry.markTransient(acquired);

      registry.release("epic-1", "chat-1", HOST);
      expect(owned.closeCount()).toBe(1);
    });

    it("still releases when the reporting turn is on a DIFFERENT host than this session's", () => {
      const registry = new ChatSessionRegistry({
        idleTtlMs: TTL_MS,
        maxWarmSessions: WARM_CAP,
      });
      const owned = createHandle("epic-1", "chat-1");
      const acquired = registry.acquire(
        { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
        () => owned.handle,
      );
      registry.markTransient(acquired);
      setLocalActivity(HOST_B, "epic-1", "chat-1", true);

      registry.release("epic-1", "chat-1", HOST);
      expect(owned.closeCount()).toBe(1);
    });

    it("still releases when access has resolved to a VIEWER, even with its own host positive", () => {
      const registry = new ChatSessionRegistry({
        idleTtlMs: TTL_MS,
        maxWarmSessions: WARM_CAP,
      });
      const owned = createHandle("epic-1", "chat-1");
      const acquired = registry.acquire(
        { epicId: "epic-1", chatId: "chat-1", hostId: HOST, scopeKey: SCOPE },
        () => owned.handle,
      );
      registry.markTransient(acquired);
      setAccess(acquired, "viewer");
      setLocalActivity(HOST, "epic-1", "chat-1", true);

      registry.release("epic-1", "chat-1", HOST);
      expect(owned.closeCount()).toBe(1);
    });
  });
});
