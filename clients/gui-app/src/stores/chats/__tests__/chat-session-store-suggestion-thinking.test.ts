import { describe, expect, it } from "vitest";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatLoadRangeRequest,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ChatTranscriptDerived } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { selectActiveThinkingTokensEstimate } from "@/stores/chats/chat-thinking-tokens";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * T14 pins: the prompt-suggestion chip (`suggestedPrompt`) and the
 * thinking-token estimate (`thinkingTokens`) as live store state.
 */

const EPIC_ID = "epic-t14";
const CHAT_ID = "chat-t14";
const OWNER_ID = "owner-t14";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly rangeRequests: ChatLoadRangeRequest[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
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
  };
}

function activeTurn(
  turnId: string,
  status: ChatActiveTurn["status"],
): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status,
    harnessId: "claude",
    model: "claude-sonnet-5",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 1,
    updatedAt: 1,
    reasoningEffort: null,
    serviceTier: null,
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

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  turn: ChatActiveTurn | null,
  suggestedPrompt: string | undefined,
  thinkingTokensEstimate: number | undefined,
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
      runStatus: turn === null ? "idle" : "running",
      activeTurn: turn,
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
      suggestedPrompt,
      thinkingTokensEstimate,
    },
  });
}

function emitTurnState(
  callbacks: ChatStreamCallbacks,
  turn: ChatActiveTurn | null,
  suggestedPrompt: string | undefined,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: turn === null ? "idle" : "running",
    activeTurn: turn,
    suggestedPrompt,
  });
}

function emitThinking(
  callbacks: ChatStreamCallbacks,
  turnId: string,
  estimate: number,
): void {
  callbacks.onThinkingTokens({
    kind: "thinkingTokens",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    turnId,
    estimate,
  });
}

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      },
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
  };
}

function completeTail(harness: Harness): void {
  const last = harness.rangeRequests.at(-1);
  if (last === undefined) throw new Error("Expected an outstanding range");
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: last.requestId,
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

function shownEstimate(harness: Harness): number | null {
  return selectActiveThinkingTokensEstimate(
    harness.handle.store.getState(),
  );
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
  turn: ChatActiveTurn | null,
  suggestedPrompt: string | undefined,
  thinkingTokensEstimate: number | undefined,
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
      runStatus: turn === null ? "idle" : "running",
      activeTurn: turn,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      // Unhydrated tail: drives the deferral branch.
      transcriptEpoch: 4,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      suggestedPrompt,
      thinkingTokensEstimate,
    },
  };
}

describe("chat-session-store suggestedPrompt and thinkingTokens (T14)", () => {
  it("seeds both from a legacy snapshot", () => {
    const harness = createHarness();
    try {
      emitSnapshot(
        harness.callbacks(),
        activeTurn("turn-1", "running"),
        "try the tests",
        321,
      );
      const state = harness.handle.store.getState();
      expect(state.suggestedPrompt).toBe("try the tests");
      expect(state.thinkingTokens).toEqual({ turnId: "turn-1", estimate: 321 });
      expect(shownEstimate(harness)).toBe(321);
    } finally {
      harness.handle.dispose();
    }
  });

  it("seeds both from a deferred windowed snapshot once the tail hydrates", () => {
    const harness = createHarness();
    try {
      harness
        .callbacks()
        .onWindowedSnapshot(
          deferredWindowedSnapshot(
            activeTurn("turn-1", "running"),
            "chip text",
            77,
          ),
        );
      completeTail(harness);
      const state = harness.handle.store.getState();
      expect(state.suggestedPrompt).toBe("chip text");
      expect(state.thinkingTokens).toEqual({ turnId: "turn-1", estimate: 77 });
    } finally {
      harness.handle.dispose();
    }
  });

  it("lets a superseding frame win over the held snapshot's values", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(
        deferredWindowedSnapshot(
          activeTurn("turn-1", "running"),
          "held chip",
          77,
        ),
      );
      emitTurnState(callbacks, activeTurn("turn-1", "running"), "newer chip");
      emitThinking(callbacks, "turn-1", 500);
      completeTail(harness);
      const state = harness.handle.store.getState();
      expect(state.suggestedPrompt).toBe("newer chip");
      expect(state.thinkingTokens).toEqual({ turnId: "turn-1", estimate: 500 });
    } finally {
      harness.handle.dispose();
    }
  });

  it("does not resurrect a held chip that a turnStateChanged cleared", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      callbacks.onWindowedSnapshot(
        deferredWindowedSnapshot(null, "held chip", undefined),
      );
      emitTurnState(callbacks, null, undefined);
      completeTail(harness);
      expect(harness.handle.store.getState().suggestedPrompt).toBeUndefined();
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears the chip on a turnStateChanged without the key, and sets it when present", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, null, "old chip", undefined);
      expect(harness.handle.store.getState().suggestedPrompt).toBe("old chip");

      emitTurnState(callbacks, null, undefined);
      expect(harness.handle.store.getState().suggestedPrompt).toBeUndefined();

      emitTurnState(callbacks, null, "new chip");
      expect(harness.handle.store.getState().suggestedPrompt).toBe("new chip");
    } finally {
      harness.handle.dispose();
    }
  });

  it("applies a thinkingTokens frame only for the live active turn", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, activeTurn("turn-1", "running"), undefined, undefined);
      expect(shownEstimate(harness)).toBe(null);

      emitThinking(callbacks, "turn-1", 100);
      expect(shownEstimate(harness)).toBe(100);

      // A frame for a turn that is not the active one is ignored.
      emitThinking(callbacks, "turn-0", 999);
      expect(harness.handle.store.getState().thinkingTokens).toEqual({
        turnId: "turn-1",
        estimate: 100,
      });
      expect(shownEstimate(harness)).toBe(100);
    } finally {
      harness.handle.dispose();
    }
  });

  it("ignores a thinkingTokens frame when no turn is active", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, null, undefined, undefined);
      emitThinking(callbacks, "turn-1", 50);
      expect(harness.handle.store.getState().thinkingTokens).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the estimate across a same-turn state frame and clears it at turn end", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, activeTurn("turn-1", "running"), undefined, undefined);
      emitThinking(callbacks, "turn-1", 100);

      emitTurnState(callbacks, activeTurn("turn-1", "running"), undefined);
      expect(shownEstimate(harness)).toBe(100);

      emitTurnState(callbacks, activeTurn("turn-1", "completed"), undefined);
      expect(harness.handle.store.getState().thinkingTokens).toBe(null);

      emitSnapshot(callbacks, activeTurn("turn-2", "running"), undefined, undefined);
      emitThinking(callbacks, "turn-2", 40);
      emitTurnState(callbacks, null, undefined);
      expect(harness.handle.store.getState().thinkingTokens).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });

  it("clears the estimate when a different turn replaces the live one", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, activeTurn("turn-1", "running"), undefined, undefined);
      emitThinking(callbacks, "turn-1", 100);
      emitTurnState(callbacks, activeTurn("turn-2", "running"), undefined);
      expect(harness.handle.store.getState().thinkingTokens).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });

  it("restores both from a reconnect snapshot after they were cleared", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, activeTurn("turn-1", "running"), "chip", 10);
      emitTurnState(callbacks, null, undefined);
      const cleared = harness.handle.store.getState();
      expect(cleared.suggestedPrompt).toBeUndefined();
      expect(cleared.thinkingTokens).toBe(null);

      callbacks.onConnectionStatus("reconnecting", null, null);
      emitSnapshot(callbacks, activeTurn("turn-3", "running"), "chip again", 250);
      const restored = harness.handle.store.getState();
      expect(restored.suggestedPrompt).toBe("chip again");
      expect(restored.thinkingTokens).toEqual({ turnId: "turn-3", estimate: 250 });
    } finally {
      harness.handle.dispose();
    }
  });

  it("a reconnect snapshot without the keys clears both", () => {
    const harness = createHarness();
    try {
      const callbacks = harness.callbacks();
      emitSnapshot(callbacks, activeTurn("turn-1", "running"), "chip", 10);
      callbacks.onConnectionStatus("reconnecting", null, null);
      emitSnapshot(callbacks, activeTurn("turn-1", "running"), undefined, undefined);
      const state = harness.handle.store.getState();
      expect(state.suggestedPrompt).toBeUndefined();
      expect(state.thinkingTokens).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });
});
