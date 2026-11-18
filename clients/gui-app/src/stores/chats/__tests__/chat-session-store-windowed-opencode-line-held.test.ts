import { describe, expect, it } from "vitest";
import type { OpencodeLineHeld } from "@traycer/protocol/common/opencode-line";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatTranscriptDerived } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-line-held";
const CHAT_ID = "chat-line-held";
const OWNER_ID = "owner-line-held";

interface WindowedHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

function createWindowedHarness(): WindowedHarness {
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

function windowedChat() {
  return {
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
  };
}

function windowedSnapshot(
  held: OpencodeLineHeld | undefined,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: windowedChat(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      opencodeLineHeld: held,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      // An empty tail folds immediately, so the snapshot lands in one frame.
      transcriptEpoch: 4,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome: undefined,
      messageDelivery: null,
    },
  };
}

describe("chat-session-store opencodeLineHeld through the windowed snapshot adapter", () => {
  it("seats the hold a snapshot carries, and clears it when a later snapshot omits it", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      expect(harness.handle.store.getState().opencodeLineHeld).toBeUndefined();

      const held: OpencodeLineHeld = { line: 1, reason: "model_unavailable" };
      callbacks.onWindowedSnapshot(windowedSnapshot(held));
      expect(harness.handle.store.getState().opencodeLineHeld).toEqual(held);

      callbacks.onWindowedSnapshot(
        windowedSnapshot({ line: 2, reason: "background_work" }),
      );
      expect(harness.handle.store.getState().opencodeLineHeld).toEqual({
        line: 2,
        reason: "background_work",
      });

      callbacks.onWindowedSnapshot(windowedSnapshot(undefined));
      expect(harness.handle.store.getState().opencodeLineHeld).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears a seated hold when a legacy snapshot replaces the windowed one", () => {
    const harness = createWindowedHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(
        windowedSnapshot({ line: 1, reason: "model_unavailable" }),
      );
      expect(harness.handle.store.getState().opencodeLineHeld).toEqual({
        line: 1,
        reason: "model_unavailable",
      });

      callbacks.onSnapshot({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        snapshot: {
          chat: { ...windowedChat(), messages: [], events: [] },
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
          portForwards: [],
          pendingFallback: undefined,
          pendingReturn: undefined,
          suggestedPrompt: undefined,
          thinkingTokensEstimate: undefined,
        },
      });
      expect(harness.handle.store.getState().opencodeLineHeld).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });
});
