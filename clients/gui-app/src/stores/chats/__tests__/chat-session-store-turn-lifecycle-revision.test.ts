import { describe, expect, it } from "vitest";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatRunStatus,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * `turnLifecycleRevision` - the counter `chat-turn-lifecycle.ts`'s
 * `nextTurnLifecycleRevision` advances, mirrored into state so a consumer
 * that captured (turnId, revision, connectionEpoch) together can tell a
 * STALE reading from a current one across an ABA cycle (a turn id, or
 * `turnInProgress`, returning to a value it already held). These tests drive
 * the real store through its public callbacks - never the helper in
 * isolation - so they prove the property survives the snapshot fold, the
 * live `onTurnStateChanged` line, and connection close, not just the pure
 * function's own arithmetic.
 */

const EPIC_ID = "epic-turn-lifecycle";
const CHAT_ID = "chat-turn-lifecycle";
const OWNER_ID = "owner-turn-lifecycle";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function emptyChat(): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: "test-host",
    title: "Host Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

/** A running turn's minimal fixture. `overrides` never changes `turnId`. */
function activeTurn(
  turnId: string,
  overrides: Partial<Omit<ChatActiveTurn, "turnId">>,
): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status: "running",
    harnessId: "codex",
    model: "gpt-5-codex",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 3,
    updatedAt: 3,
    reasoningEffort: null,
    serviceTier: null,
    ...overrides,
  };
}

interface SnapshotLifecycle {
  readonly runStatus: ChatRunStatus;
  readonly activeTurn: ChatActiveTurn | null;
  readonly turnInProgress: boolean | undefined;
}

/** Opens the connection (if not already open) and seats an authoritative snapshot. */
function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  lifecycle: SnapshotLifecycle,
): void {
  callbacks.onConnectionStatus("open", null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: emptyChat(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: lifecycle.runStatus,
      activeTurn: lifecycle.activeTurn,
      turnInProgress: lifecycle.turnInProgress,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome: undefined,
    },
  });
}

/**
 * Drives the live `turnStateChanged` line. `turnInProgress: undefined` omits
 * the key from the frame entirely - the same shape a pre-`turnInProgress`
 * host sends - rather than sending an explicit `undefined` value, so the
 * store's `frame.turnInProgress ?? state.turnInProgress` fallback is
 * exercised the way a real legacy peer triggers it.
 */
function emitTurnState(
  callbacks: ChatStreamCallbacks,
  lifecycle: SnapshotLifecycle,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: lifecycle.runStatus,
    activeTurn: lifecycle.activeTurn,
    ...(lifecycle.turnInProgress === undefined
      ? {}
      : { turnInProgress: lifecycle.turnInProgress }),
  });
}

describe("chat-session-store turnLifecycleRevision", () => {
  it("starts at 0 before any frame lands", () => {
    const harness = createHarness();
    try {
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(0);
    } finally {
      harness.handle.dispose();
    }
  });

  it("the authoritative-snapshot fold advances on a real transition and holds on a same-tuple repeat", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();

      // Cold snapshot landing on the already-idle initial state: the
      // normalized tuple does not move, so this must NOT be counted as the
      // chat's "first" turn.
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(0);

      emitSnapshot(callbacks, {
        runStatus: "running",
        activeTurn: activeTurn("turn-1", {}),
        turnInProgress: true,
      });
      // Falsification: drop the `turnLifecycleRevision` write from
      // `applyAuthoritativeSnapshot`'s return object and this stays 0.
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(1);

      // Same turnId, same turnInProgress, only unrelated metadata (`updatedAt`)
      // differs - a resend of the same authoritative state, which a host can
      // legitimately do on a resnapshot.
      emitSnapshot(callbacks, {
        runStatus: "running",
        activeTurn: activeTurn("turn-1", { updatedAt: 999 }),
        turnInProgress: true,
      });
      // Falsification: compare `activeTurn` by deep-equality instead of by
      // `turnId` in `nextTurnLifecycleRevision` and this goes to 2 - the
      // whole point of normalizing to the id is that metadata churn on an
      // otherwise-unchanged turn must not read as a new lifecycle event.
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("the live line bumps once per real ID transition (null -> A -> B -> null) and not on a same-ID metadata frame", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });

      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: activeTurn("turn-1", {}),
        turnInProgress: true,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(1);

      // Metadata-only frame for the SAME turn: must not bump.
      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: activeTurn("turn-1", { updatedAt: 55 }),
        turnInProgress: true,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(1);

      // A -> B: the id changes even though `turnInProgress` stays `true`.
      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: activeTurn("turn-2", {}),
        turnInProgress: true,
      });
      // Falsification: normalize the changed-check to `turnInProgress`
      // alone (drop the `activeTurn?.turnId` comparison) and this stays 1 -
      // turn-1 handing off to turn-2 without an intervening idle tick would
      // then be invisible to any consumer keyed on the revision.
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(2);

      // B -> null: the turn settles.
      emitTurnState(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: false,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(3);
    } finally {
      harness.handle.dispose();
    }
  });

  it("an ID-less activation cycle (turnInProgress true -> false -> true, activeTurn always null) still bumps on every step, including the return to true", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: false,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(0);

      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: null,
        turnInProgress: true,
      });
      const afterFirstTrue =
        harness.handle.store.getState().turnLifecycleRevision;
      expect(afterFirstTrue).toBe(1);

      emitTurnState(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: false,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(2);

      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: null,
        turnInProgress: true,
      });
      const afterSecondTrue =
        harness.handle.store.getState().turnLifecycleRevision;
      expect(afterSecondTrue).toBe(3);
      // Falsification: a consumer that only compares `turnInProgress` values
      // (rather than the revision) would read `afterFirstTrue` and
      // `afterSecondTrue` as the "same" `true` and miss the intervening
      // activation entirely - the ABA case this counter exists to close.
      expect(afterSecondTrue).not.toBe(afterFirstTrue);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a legacy host that never sends turnInProgress still advances the revision off the runStatus idle boundary", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });
      expect(harness.handle.store.getState().turnInProgress).toBeUndefined();

      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: null,
        turnInProgress: undefined,
      });
      // Falsification: seed `previousInProgress`/`nextInProgress` from
      // `turnInProgress` alone with no `runStatus !== "idle"` fallback and
      // this stays 0 for a peer old enough to never send the field.
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(1);
      // The field itself is still genuinely absent - the boundary came from
      // `runStatus`, not from some frame quietly supplying a boolean.
      expect(harness.handle.store.getState().turnInProgress).toBeUndefined();

      emitTurnState(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });
      expect(harness.handle.store.getState().turnLifecycleRevision).toBe(2);
    } finally {
      harness.handle.dispose();
    }
  });

  it("a connection close that clears an active turn advances the revision; closing an already-idle connection does not", () => {
    const running = createHarness();
    try {
      const callbacks = running.callbacks();
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });
      emitTurnState(callbacks, {
        runStatus: "running",
        activeTurn: activeTurn("turn-1", {}),
        turnInProgress: true,
      });
      expect(running.handle.store.getState().turnLifecycleRevision).toBe(1);

      callbacks.onConnectionStatus("closed", null, null);
      const closed = running.handle.store.getState();
      // The close's own state rewrite - asserted so the revision bump below
      // is read against the transition it is actually reporting, not taken
      // on faith.
      expect(closed.activeTurn).toBeNull();
      expect(closed.runStatus).toBe("idle");
      // Falsification: drop the `turnLifecycleRevision` write from the
      // `onConnectionStatus` "closed" branch and this stays 1 - a Stop
      // confirmation captured against turn-1 would then survive a connection
      // drop that silently discarded the turn it was for.
      expect(closed.turnLifecycleRevision).toBe(2);
    } finally {
      running.handle.dispose();
    }

    const idle = createHarness();
    try {
      const callbacks = idle.callbacks();
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });
      expect(idle.handle.store.getState().turnLifecycleRevision).toBe(0);

      callbacks.onConnectionStatus("closed", null, null);
      const closed = idle.handle.store.getState();
      expect(closed.activeTurn).toBeNull();
      expect(closed.runStatus).toBe("idle");
      // The normalized tuple was already (null, false) - closing a connection
      // with nothing running must not manufacture a lifecycle event.
      expect(closed.turnLifecycleRevision).toBe(0);
    } finally {
      idle.handle.dispose();
    }
  });

  it("subscribers observe the turn id and the revision atomically - never a frame with one moved and not the other", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, {
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: undefined,
      });

      const observed: { turnId: string | null; revision: number }[] = [];
      const unsubscribe = harness.handle.store.subscribe((state) => {
        observed.push({
          turnId: state.activeTurn?.turnId ?? null,
          revision: state.turnLifecycleRevision,
        });
      });
      try {
        emitTurnState(callbacks, {
          runStatus: "running",
          activeTurn: activeTurn("turn-1", {}),
          turnInProgress: true,
        });
        emitTurnState(callbacks, {
          runStatus: "idle",
          activeTurn: null,
          turnInProgress: false,
        });
      } finally {
        unsubscribe();
      }

      // One `set()` per `onTurnStateChanged` call, so a subscriber sees the
      // new turnId and the incremented revision together in the SAME
      // notification - not a torn read where one field lags the other by a
      // tick, which is what would let a UI's captured revision go stale a
      // notification late.
      expect(observed).toEqual([
        { turnId: "turn-1", revision: 1 },
        { turnId: null, revision: 2 },
      ]);
    } finally {
      harness.handle.dispose();
    }
  });
});
