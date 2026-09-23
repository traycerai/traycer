import { describe, expect, it } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatMessageDelivery } from "@traycer/protocol/host/agent/gui/message-delivery";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
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
 * `messageDelivery`'s deferred-windowed-snapshot supersession, on the exact
 * model `chat-session-store-last-fallback-outcome.test.ts` (D215) pins for
 * `lastFallbackOutcome`: `onMessageDeliveryChanged` writes the live state
 * directly AND calls `advanceDeferredSnapshotAux`, the same two-write shape
 * `onTurnStateChanged` uses there. A held snapshot's `messageDelivery` must
 * not survive being superseded by a live push that arrives before the tail
 * hydrates, and a later re-entry of the SAME deferred frame must not
 * resurrect the snapshot's original value over the superseding one.
 *
 * Own file for the same reason D215 is its own file: the shared helpers this
 * boundary needs (`deferredWindowedSnapshot`, `completeTail`) don't thread
 * `messageDelivery`, and widening them would cost every existing call site an
 * argument it does not use.
 */

const EPIC_ID = "epic-delivery-deferred";
const CHAT_ID = "chat-delivery-deferred";
const OWNER_ID = "owner-delivery-deferred";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
  identityId: null,
};

function delivery(
  messageId: string,
  revision: number,
  phase: "pending" | "preparing",
): ChatMessageDelivery {
  return { messageId, revision, state: { phase } };
}

const DELIVERY_A = delivery("message-1", 1, "pending");
const DELIVERY_B = delivery("message-1", 2, "preparing");

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
        draftBlobBridgeSupported: () => false,
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

function emitMessageDeliveryChanged(
  callbacks: ChatStreamCallbacks,
  value: ChatMessageDelivery | null,
): void {
  callbacks.onMessageDeliveryChanged({
    kind: "messageDeliveryChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    delivery: value,
  });
}

const WINDOWED_DERIVED: ChatTranscriptDerived = {
  latestAssistantUsage: null,
  pinnedTodo: null,
  pinnedTaskTodoItems: [],
  latestForkableAssistantMessageId: null,
  restorableSetupInterruption: null,
  interviewAnswerability: [],
  latestAssistantAuthFailureTurnKey: null,
  setupCardWindows: [],
};

function deferredWindowedSnapshot(
  value: ChatMessageDelivery | null,
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
        kind: "conversation",
        evolutionTurnsSinceReview: null,
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
      portForwards: [],
      // Unhydrated tail - `isTailHydrated` reads this false - so every case
      // below drives the DEFERRAL branch, not the ordinary fold.
      transcriptEpoch: 4,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome: undefined,
      messageDelivery: value,
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

describe("chat-session-store messageDelivery: deferred-windowed-snapshot supersession", () => {
  it("seats a messageDelivery-bearing windowed snapshot IMMEDIATELY, before the tail hydrates", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(DELIVERY_A));

      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_A,
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the SUPERSEDING messageDelivery, not the held snapshot's original, once the tail hydrates", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(DELIVERY_A));
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_A,
      );

      // A messageDeliveryChanged push arrives WHILE the snapshot is still
      // held and supersedes the value.
      emitMessageDeliveryChanged(callbacks, DELIVERY_B);
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_B,
      );

      completeTail(harness);

      // Falsification: drop the `messageDelivery: frame.delivery` line from
      // `advanceDeferredSnapshotAux`'s `onMessageDeliveryChanged` caller -
      // the held aux keeps replaying DELIVERY_A and this goes red once the
      // fold runs and re-seats from the (unsuperseded) aux.
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_B,
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not resurrect a superseded messageDelivery on RE-ENTRY of the deferral branch", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(DELIVERY_A));
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_A,
      );

      // Supersede while still held.
      emitMessageDeliveryChanged(callbacks, DELIVERY_B);

      // A range response that does NOT complete the tail - re-entry of the
      // SAME deferred frame, so the store defers AGAIN rather than running
      // the fold. Without the `heldAux` guard, this second pass would
      // re-derive from the ORIGINAL frame's own aux and resurrect DELIVERY_A.
      callbacks.onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        range: {
          requestId: harness.lastRangeRequestId(),
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["row-0"],
          messages: [userMessage("m-0", 0)],
          events: [],
          rowContext: {},
          reachedStart: false,
          reachedEnd: false,
        },
      });

      // Non-vacuousness: still deferred (not hydrated) is what proves this
      // response actually re-entered the deferral branch rather than
      // completing the tail or short-circuiting before touching
      // `messageDelivery` - either of which would read DELIVERY_B too, for
      // the wrong reason (it was already written live by the push above).
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_B,
      );

      completeTail(harness);
      expect(harness.handle.store.getState().messageDelivery).toEqual(
        DELIVERY_B,
      );
    } finally {
      harness.handle.dispose();
    }
  });

  it("supersedes down to null (delivery cleared/started) while held, and the clear survives hydration", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(DELIVERY_A));
      emitMessageDeliveryChanged(callbacks, null);
      expect(harness.handle.store.getState().messageDelivery).toBeNull();

      completeTail(harness);
      expect(harness.handle.store.getState().messageDelivery).toBeNull();
    } finally {
      harness.handle.dispose();
    }
  });

  it("drops every local copy of a withdrawn message in the SAME deferred-seat update, before the tail hydrates", () => {
    // D215's own immediate-seat rule ("the OUTCOME is seated immediately")
    // extends to the delivery view: `withoutWithdrawnOpeningCopies` runs in
    // the exact `set()` that seats a held aux's `messageDelivery`, not only
    // once the tail later hydrates. This is the third of the three seating
    // paths that apply the gate (`onMessageDeliveryChanged` and the ordinary
    // `onSnapshot` fold are covered elsewhere) - the windowed/deferred one.
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onConnectionStatus("open", null, null);
      // `sendMessage` gates on `canSendAction` (connectionStatus + canAct);
      // this harness never folds a snapshot, so `access` needs setting by
      // hand for the send below to go through at all.
      harness.handle.store.setState({
        access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      });
      const sent = harness.handle.store.getState().sendMessage({
        content: CONTENT,
        sender: { type: "user", userId: OWNER_ID },
        settings: SETTINGS,
        attachments: [],
        deliveryPolicy: "auto",
        restore: { content: CONTENT, browserAnnotations: [] },
      });
      expect(sent).not.toBeNull();
      if (sent === null) throw new Error("sendMessage was refused");

      const before = harness.handle.store.getState();
      expect(before.pendingActions[sent.clientActionId]).toBeDefined();
      expect(
        before.pendingUserMessages.some(
          (message) => message.messageId === sent.messageId,
        ),
      ).toBe(true);

      const withdrawal: ChatMessageDelivery = {
        messageId: sent.messageId,
        revision: 1,
        state: {
          phase: "withdrawn",
          code: "MESSAGE_START_INTERRUPTED",
          reason: "The opening message was not sent.",
          missingHashes: [],
          restore: { content: CONTENT },
          restoreClaimed: false,
        },
      };
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(withdrawal));

      // Still deferred (not hydrated): proves this assertion reads the
      // IMMEDIATE seat, not a fold that only runs once the tail completes.
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);
      const after = harness.handle.store.getState();
      expect(after.messageDelivery?.messageId).toBe(sent.messageId);
      expect(after.pendingActions[sent.clientActionId]).toBeUndefined();
      expect(
        after.pendingUserMessages.some(
          (message) => message.messageId === sent.messageId,
        ),
      ).toBe(false);
    } finally {
      harness.handle.dispose();
    }
  });
});
