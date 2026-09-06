import { describe, expect, it } from "vitest";
import type { Chat, Message } from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
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
import {
  FAILED_CLAUDE_TUPLE,
  PREFERRED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
  pendingReturn,
} from "@/components/chat/fallback/__tests__/fallback-fixtures";

const EPIC_ID = "epic-fallback";
const CHAT_ID = "chat-fallback";
const OWNER_ID = "owner-fallback";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const HOLD = pendingFallback({
  state: "hold",
  reason: "rate_limit",
  failedTuple: FAILED_CLAUDE_TUPLE,
  targetTuple: TARGET_CODEX_TUPLE,
  deadline: 1_700_000_012_000,
  attempt: 1,
  maxAttempts: 3,
  queuedItemsMoving: 2,
  siblingSwitching: 1,
  traversalId: "traversal-store",
  revision: 4,
});

const RETURN = pendingReturn({
  preferredTuple: PREFERRED_CLAUDE_TUPLE,
  fallbackTuple: TARGET_CODEX_TUPLE,
  queuedItemsMoving: 1,
  traversalId: "traversal-return-store",
  revision: 6,
});

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
  pending: PendingFallback | undefined,
  returning: PendingReturn | undefined,
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
      pendingFallback: pending,
      pendingReturn: returning,
    },
  });
}

function emitTurnState(
  callbacks: ChatStreamCallbacks,
  pending: PendingFallback | undefined,
  returning: PendingReturn | undefined,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: pending,
    pendingReturn: returning,
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
  pending: PendingFallback | undefined,
  returning: PendingReturn | undefined,
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
      transcriptEpoch: 4,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: pending,
      pendingReturn: returning,
    },
  };
}

describe("chat-session-store pendingFallback / pendingReturn D115", () => {
  it("clears both DTOs when an authoritative snapshot writes undefined", () => {
    const harness = createLegacyHarness();
    try {
      const callbacks = harness.callbacks();
      emitLegacySnapshot(callbacks, HOLD, RETURN);
      expect(harness.handle.store.getState().pendingFallback).toEqual(HOLD);
      expect(harness.handle.store.getState().pendingReturn).toEqual(RETURN);

      emitLegacySnapshot(callbacks, undefined, undefined);
      // Falsification: add "?? current.pendingFallback" to the applyAuthoritativeSnapshot write in chat-session-store.ts and THIS assertion must go red.
      expect(harness.handle.store.getState().pendingFallback).toBeUndefined();
      expect(harness.handle.store.getState().pendingReturn).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears both DTOs when turnStateChanged writes undefined", () => {
    const harness = createLegacyHarness();
    try {
      const callbacks = harness.callbacks();
      emitLegacySnapshot(callbacks, undefined, undefined);
      emitTurnState(callbacks, HOLD, RETURN);
      expect(harness.handle.store.getState().pendingFallback).toEqual(HOLD);
      expect(harness.handle.store.getState().pendingReturn).toEqual(RETURN);

      emitTurnState(callbacks, undefined, undefined);
      // Falsification: add "?? current.pendingFallback" to the turnStateChanged write in chat-session-store.ts and THIS assertion must go red.
      expect(harness.handle.store.getState().pendingFallback).toBeUndefined();
      expect(harness.handle.store.getState().pendingReturn).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears both DTOs through the deferred windowed-snapshot aux, ending at undefined", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(deferredWindowedSnapshot(HOLD, RETURN));
      expect(
        isTailHydrated(harness.handle.store.getState().transcriptWindow),
      ).toBe(false);

      emitTurnState(callbacks, undefined, undefined);
      expect(harness.handle.store.getState().pendingFallback).toBeUndefined();
      expect(harness.handle.store.getState().pendingReturn).toBeUndefined();

      callbacks.onRange({
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

      // Falsification: add "?? held.pendingFallback" to the turnStateChanged deferred-aux write in chat-session-store.ts and THIS assertion must go red.
      expect(harness.handle.store.getState().pendingFallback).toBeUndefined();
      expect(harness.handle.store.getState().pendingReturn).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });
});
