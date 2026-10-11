import { afterEach, describe, expect, it, vi } from "vitest";
import { chatActiveTurnSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * Only the registry boundary is mocked - `chat-turn-completions.ts` itself,
 * the real `ChatSessionStoreHandle`, and its real store transitions all run
 * for real below, so this proves the actual wiring (`getChatSessionHandleHostId`
 * for `hostId`, `activeTurn.profileId` for `profileId`) rather than a copy of
 * it.
 */
const registryMocks = vi.hoisted(() => ({
  handles: [] as ChatSessionStoreHandle[],
  hostIdByHandle: new Map<ChatSessionStoreHandle, string | null>(),
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({
    listHandles: () => registryMocks.handles,
    subscribe: () => () => undefined,
  }),
  getChatSessionHandleHostId: (handle: ChatSessionStoreHandle) =>
    registryMocks.hostIdByHandle.get(handle) ?? null,
}));

import {
  advanceTurnNotify,
  seedTurnNotifyState,
  subscribeChatTurnCompletions,
  toChatTurnPhase,
  INITIAL_TURN_NOTIFY_STATE,
  type ChatTurnCompletion,
  type ChatTurnPhase,
  type TurnNotifyState,
} from "@/lib/chats/chat-turn-completions";

function phase(overrides: Partial<ChatTurnPhase>): ChatTurnPhase {
  return {
    runningTurn: false,
    stopping: false,
    turnEnded: false,
    connectionClosed: false,
    ...overrides,
  };
}

const RUNNING = phase({ runningTurn: true });
const STOPPING = phase({ stopping: true });
const TURN_ENDED = phase({ turnEnded: true });
const CLOSED = phase({ connectionClosed: true, turnEnded: true });

function runSequence(
  seed: ChatTurnPhase,
  steps: ReadonlyArray<ChatTurnPhase>,
): ReadonlyArray<boolean> {
  let state: TurnNotifyState = seedTurnNotifyState(seed);
  return steps.map((step) => {
    const result = advanceTurnNotify(state, step);
    state = result.state;
    return result.completed;
  });
}

describe("advanceTurnNotify", () => {
  it("fires once when a running turn ends", () => {
    const afterRun = advanceTurnNotify(INITIAL_TURN_NOTIFY_STATE, RUNNING);
    expect(afterRun.completed).toBe(false);
    expect(afterRun.state.armed).toBe(true);

    const afterEnd = advanceTurnNotify(afterRun.state, TURN_ENDED);
    expect(afterEnd.completed).toBe(true);
    expect(afterEnd.state).toEqual(INITIAL_TURN_NOTIFY_STATE);
  });

  it("does not fire on a closed socket and drops the latch", () => {
    const armed = advanceTurnNotify(INITIAL_TURN_NOTIFY_STATE, RUNNING).state;
    const afterClose = advanceTurnNotify(armed, CLOSED);
    expect(afterClose.completed).toBe(false);
    expect(afterClose.state).toEqual(INITIAL_TURN_NOTIFY_STATE);
  });

  it("does not fire for a user-initiated stop", () => {
    expect(runSequence(TURN_ENDED, [RUNNING, STOPPING, TURN_ENDED])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("stays armed across an intermediate frame before the turn ends", () => {
    const runningWithoutActiveTurn = phase({ turnEnded: false });
    expect(
      runSequence(TURN_ENDED, [RUNNING, runningWithoutActiveTurn, TURN_ENDED]),
    ).toEqual([false, false, true]);
  });

  it("counts a turn already running when first observed", () => {
    expect(runSequence(RUNNING, [TURN_ENDED])).toEqual([true]);
  });

  it("does not fire on reconnect until a turn runs again", () => {
    expect(runSequence(TURN_ENDED, [RUNNING, CLOSED, TURN_ENDED])).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      runSequence(TURN_ENDED, [RUNNING, CLOSED, RUNNING, TURN_ENDED]),
    ).toEqual([false, false, false, true]);
  });
});

describe("toChatTurnPhase", () => {
  const activeTurn = chatActiveTurnSchema.parse({
    turnId: "turn-1",
    status: "running",
    harnessId: "claude",
    model: "claude-opus",
    userMessageId: "msg-1",
    startedAt: 0,
    updatedAt: 0,
  });

  it("projects a running turn", () => {
    expect(
      toChatTurnPhase({
        runStatus: "running",
        activeTurn,
        queue: { status: "idle", items: [] },
        connectionStatus: "open",
      }),
    ).toEqual({
      runningTurn: true,
      stopping: false,
      turnEnded: false,
      connectionClosed: false,
    });
  });

  it("projects an ended turn in a connected chat", () => {
    expect(
      toChatTurnPhase({
        runStatus: "idle",
        activeTurn: null,
        queue: { status: "idle", items: [] },
        connectionStatus: "open",
      }),
    ).toEqual({
      runningTurn: false,
      stopping: false,
      turnEnded: true,
      connectionClosed: false,
    });
  });

  it("projects an errored turn as complete while its queued messages remain paused", () => {
    expect(
      toChatTurnPhase({
        runStatus: "idle",
        activeTurn: null,
        queue: {
          status: "paused",
          items: [
            {
              kind: "prompt",
              queueItemId: "queued-after-error",
              messageId: "message-2",
              message: {
                kind: "user",
                content: {
                  type: "doc",
                  content: [{ type: "paragraph" }],
                },
                browserAnnotations: [],
              },
              sender: { type: "user", userId: "user-1" },
              settings: {
                harnessId: "claude",
                model: "claude-opus",
                permissionMode: "supervised",
                reasoningEffort: null,
                serviceTier: null,
                agentMode: "regular",
                profileId: "work",
              },
              accountContext: { type: "PERSONAL" },
              sentFromHostId: null,
              delivery: "next_turn",
              status: "paused",
              targetTurnId: null,
              steerRequest: null,
              fallbackReason: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        connectionStatus: "open",
      }),
    ).toEqual({
      runningTurn: false,
      stopping: false,
      turnEnded: true,
      connectionClosed: false,
    });
  });
});

describe("subscribeChatTurnCompletions producer identity", () => {
  afterEach(() => {
    registryMocks.handles = [];
    registryMocks.hostIdByHandle = new Map();
  });

  it("carries the registry's hostId and the completed turn's real profileId, not the store's own construction-time hostId", () => {
    const callbacksHolder: { current: ChatStreamCallbacks | null } = {
      current: null,
    };
    function callbacks(): ChatStreamCallbacks {
      if (callbacksHolder.current === null) {
        throw new Error("expected callbacks");
      }
      return callbacksHolder.current;
    }
    const handle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      // Deliberately different from the registry mock's hostId below: a
      // wiring bug that read this field instead of the registry lookup would
      // still pass any test that used the same value for both.
      hostId: "store-construction-host",
      epicId: "epic-1",
      chatId: "chat-1",
      userId: "user-1",
      onAuthError: null,
      onProviderAuthError: null,
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
        callbacksHolder.current = nextCallbacks;
        return {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => false,
          draftBlobBridgeSupported: () => false,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        };
      },
    });
    registryMocks.handles = [handle];
    registryMocks.hostIdByHandle.set(handle, "registry-host-b");

    const completions: ChatTurnCompletion[] = [];
    const unsubscribe = subscribeChatTurnCompletions((completion) => {
      completions.push(completion);
    });

    callbacks().onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        profileId: "work-profile",
        userMessageId: "message-1",
        startedAt: 1,
        updatedAt: 1,
        reasoningEffort: null,
        serviceTier: null,
      },
    });
    callbacks().onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      runStatus: "idle",
      activeTurn: null,
    });

    expect(completions).toEqual([
      {
        hostId: "registry-host-b",
        profileId: "work-profile",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: null,
        harnessId: "codex",
      },
    ]);

    unsubscribe();
    handle.dispose();
  });
});
