import { describe, expect, it } from "vitest";
import type { Chat, Message } from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { isTailHydrated } from "@/stores/chats/transcript-window";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * F14 (`lastFailedAttempt`) pins - the review's biggest gap: nothing in the
 * store test directory asserted this DTO exists at all.
 *
 * Its own file, matching `chat-session-store-last-fallback-outcome.test.ts`'s
 * reasoning rather than extending `chat-session-store-pending-fallback.test.ts`:
 * that file's `emitLegacySnapshot`/`emitTurnState`/`deferredWindowedSnapshot`
 * helpers do not thread this field, and widening them would cost every
 * existing call site a required argument it does not exercise.
 *
 * `undefined` here is a VALUE (the attempt was consumed / superseded /
 * turn ended cleanly), never an omission - the same rule D215 pins for
 * `lastFallbackOutcome`. A `??` on any of the three write sites below would
 * make a failed turn's retry/switch/wait affordances immortal.
 */

const EPIC_ID = "epic-attempt";
const CHAT_ID = "chat-attempt";
const OWNER_ID = "owner-attempt";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function attempt(input: {
  readonly userMessageId: string;
  readonly turnId: string;
}): LastFailedAttempt {
  return {
    userMessageId: input.userMessageId,
    turnId: input.turnId,
    failure: { reason: "rate_limit" },
    eligibleRungs: ["retry", "switch"],
    waitDisposition: "no_verified_reset",
    // `switch` is in `eligibleRungs` above, so `eligible` is the one value the
    // producer could have paired with it - the two are one host decision.
    switchDisposition: "eligible",
    failedTuple: null,
  };
}

const ATTEMPT_A = attempt({ userMessageId: "user-a", turnId: "turn-a" });
const ATTEMPT_B = attempt({ userMessageId: "user-b", turnId: "turn-b" });

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

interface LegacyHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

function createLegacyHarness(): LegacyHarness {
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

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
  lastRangeRequestId(): string;
}

function createWindowedHarness(): WindowedHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
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
        requestTranscriptRange: (request) => {
          rangeRequests.push(request);
        },
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
    lastRangeRequestId: () => {
      const last = rangeRequests.at(-1);
      if (last === undefined) throw new Error("Expected an outstanding range");
      return last.requestId;
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

function emitLegacySnapshot(
  callbacks: ChatStreamCallbacks,
  lastFailedAttempt: LastFailedAttempt | undefined,
): void {
  callbacks.onConnectionStatus("open", null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: emptyChat(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFailedAttempt,
    },
  });
}

function emitTurnState(
  callbacks: ChatStreamCallbacks,
  lastFailedAttempt: LastFailedAttempt | undefined,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: undefined,
    pendingReturn: undefined,
    lastFailedAttempt,
  });
}

const WINDOWED_DERIVED: ChatTranscriptDerived = {
  latestAssistantUsage: null,
  pinnedTodo: null,
  pinnedTaskTodoItems: [],
  latestForkableAssistantMessageId: "assistant-9",
  restorableSetupInterruption: null,
  interviewAnswerability: [],
  latestAssistantAuthFailureTurnKey: null,
  setupCardWindows: [],
};

function deferredWindowedSnapshot(
  lastFailedAttempt: LastFailedAttempt | undefined,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "host-a",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      // Unhydrated tail (same construction as the D215 file's) - every case
      // below drives the DEFERRAL branch, not the ordinary fold. `rowCount: 2`
      // with `fromOrdinal: 0` below leaves ordinal 1 uncovered, so a partial
      // range genuinely stays partial rather than accidentally completing the
      // tail (the D219 trap `last-fallback-outcome`'s re-entry test hit).
      transcriptEpoch: 4,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFailedAttempt,
    },
  };
}

function completeTail(harness: WindowedHarness): void {
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: harness.lastRangeRequestId(),
      epoch: 4,
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      events: [],
      rowContext: {},
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

describe("chat-session-store lastFailedAttempt F14", () => {
  it("sets an attempt through a legacy snapshot, and clears it back to undefined through one", () => {
    const harness = createLegacyHarness();
    try {
      const callbacks = harness.callbacks();
      emitLegacySnapshot(callbacks, ATTEMPT_A);
      expect(harness.handle.store.getState().lastFailedAttempt).toBe(ATTEMPT_A);

      emitLegacySnapshot(callbacks, undefined);
      // Falsification: add "?? current.lastFailedAttempt" to the
      // applyAuthoritativeSnapshot write and THIS assertion must go red -
      // `undefined` here means the turn ended without leaving a failed
      // attempt behind, not "the host said nothing this frame".
      expect(harness.handle.store.getState().lastFailedAttempt).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("sets and clears an attempt through turnStateChanged", () => {
    const harness = createLegacyHarness();
    try {
      const callbacks = harness.callbacks();
      emitLegacySnapshot(callbacks, undefined);
      emitTurnState(callbacks, ATTEMPT_A);
      expect(harness.handle.store.getState().lastFailedAttempt).toBe(ATTEMPT_A);

      emitTurnState(callbacks, undefined);
      // Falsification: add "?? state.lastFailedAttempt" to the
      // turnStateChanged write and THIS assertion must go red.
      expect(harness.handle.store.getState().lastFailedAttempt).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears a HELD attempt once the tail hydrates, rather than replaying it", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      const snapshot = deferredWindowedSnapshot(ATTEMPT_A);
      callbacks.onWindowedSnapshot(snapshot);

      // Precondition: this snapshot is genuinely deferred, so what follows
      // exercises the deferral branch, not the ordinary fold.
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);

      // A turnStateChanged supersedes it to undefined WHILE the snapshot is
      // still held - the turn ended cleanly (retried and succeeded) before
      // the tail arrived.
      emitTurnState(callbacks, undefined);
      expect(harness.handle.store.getState().lastFailedAttempt).toBeUndefined();

      completeTail(harness);

      // Falsification: in `advanceDeferredSnapshotAux`'s turnStateChanged
      // caller, drop the `lastFailedAttempt: frame.lastFailedAttempt` line -
      // the held aux keeps carrying ATTEMPT_A and THIS assertion goes red
      // once the fold runs and re-seats from the (unsuperseded) aux.
      expect(harness.handle.store.getState().lastFailedAttempt).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps a NEW attempt on the same-turn retry, distinct from the one it superseded", () => {
    // Companion to the clear-on-supersession case above: the held aux must
    // carry whatever the LATEST frame says, not just "cleared or not" -
    // ATTEMPT_B replacing ATTEMPT_A is the same code path as ATTEMPT_A being
    // replaced by undefined, and a fix that only threads the undefined case
    // (e.g. `lastFailedAttempt: frame.lastFailedAttempt ?? undefined` reading
    // as correct by accident) would still fail this one.
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(ATTEMPT_A));

      // The same precondition the clear-on-supersession case above states, and
      // for a sharper reason here: `emitTurnState` writes ATTEMPT_B into LIVE
      // state, so both assertions below pass whether or not the snapshot was
      // ever deferred. Without this line a fixture that stopped producing an
      // unhydrated tail would leave this case green while proving nothing about
      // the aux path it is named for - the trap
      // `chat-session-store-last-fallback-outcome.test.ts` documents on its own
      // deferred fixture.
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);

      emitTurnState(callbacks, ATTEMPT_B);
      expect(harness.handle.store.getState().lastFailedAttempt).toBe(ATTEMPT_B);

      completeTail(harness);

      // The aux fold has now run: the value that survives it is the one the
      // LATEST frame carried, not the ATTEMPT_A the held snapshot arrived with.
      expect(harness.handle.store.getState().lastFailedAttempt).toBe(ATTEMPT_B);
    } finally {
      harness.handle.dispose();
    }
  });
});
