import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatSubscribeServerFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { usePortForwardsForChat } from "@/stores/port-forwards/port-forwards-for-chat";

/**
 * The read side of the chat's Background panel port-forward rows.
 *
 * Modeled on `src/stores/managed-commands/test-support/managed-command-chat-session.ts`:
 * a real chat session store, registered through the real registry, fed a real
 * `portForwardsChanged` frame. The only faked boundary is the socket.
 */

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";
const TEST_SCOPE_KEY = "port-forward-for-chat-test-scope";
const TEST_USER_ID = "user-1";

type ChatSnapshot = Extract<
  ChatSubscribeServerFrame,
  { readonly kind: "snapshot" }
>["snapshot"];

interface PortForwardChatSessionStub {
  readonly setPortForwards: (forwards: readonly ChatPortForward[]) => void;
  readonly dispose: () => void;
}

function installPortForwardChatSession(): PortForwardChatSessionStub {
  const registry = __getChatSessionRegistryForTests();
  let captured: ChatStreamCallbacks | null = null;

  registry.acquire(
    {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: TEST_SCOPE_KEY,
    },
    (storeEpicId, storeChatId) =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: HOST_ID,
        epicId: storeEpicId,
        chatId: storeChatId,
        userId: null,
        streamClientFactory: (_epicId, _chatId, callbacks) => {
          captured = callbacks;
          return {
            sendAction: () => undefined,
            close: () => undefined,
            sameTurnSteeringProtocolSupported: () => true,
            draftBlobBridgeSupported: () => true,
            requestTranscriptRange: () => undefined,
            requestResnapshot: () => undefined,
          };
        },
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
      }),
  );

  const callbacks = (): ChatStreamCallbacks => {
    if (captured === null) {
      throw new Error("chat stream callbacks were never wired");
    }
    return captured;
  };

  let snapshotDelivered = false;

  return {
    setPortForwards: (forwards) => {
      if (snapshotDelivered) {
        callbacks().onPortForwardsChanged({
          kind: "portForwardsChanged",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          portForwards: [...forwards],
        });
        return;
      }
      snapshotDelivered = true;
      callbacks().onSnapshot({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        snapshot: emptyChatSnapshot(forwards),
      });
    },
    dispose: () => {
      registry.forceRelease(EPIC_ID, CHAT_ID, HOST_ID);
    },
  };
}

function emptyChatSnapshot(
  portForwards: readonly ChatPortForward[],
): ChatSnapshot {
  return {
    chat: {
      id: CHAT_ID,
      parentId: null,
      userId: TEST_USER_ID,
      hostId: HOST_ID,
      title: "Chat",
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
      kind: "conversation",
      evolutionTurnsSinceReview: null,
    },
    access: { role: "owner", ownerUserId: TEST_USER_ID, canAct: true },
    queue: { status: "idle", items: [] },
    runStatus: "idle",
    activeTurn: null,
    turnInProgress: false,
    pendingApprovals: [],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
    accumulatedFileChanges: [],
    backgroundItems: [],
    managedCommands: [],
    heldUpdates: [],
    portForwards: [...portForwards],
  };
}

function forward(over: Partial<ChatPortForward>): ChatPortForward {
  return {
    forwardId: "forward-1",
    description: "dev server",
    target: { hostId: "host-target", port: 3000 },
    listen: { hostId: "host-listen", requestedPort: 8080, boundPort: null },
    state: "active",
    stateReason: null,
    createdAtMs: 1,
    recentEvents: [],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  __getChatSessionRegistryForTests().disposeAll();
});

describe("usePortForwardsForChat", () => {
  it("reads as an empty, stable array reference for a chat with no live session", () => {
    const { result, rerender } = renderHook(() =>
      usePortForwardsForChat({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      }),
    );

    expect(result.current).toEqual([]);
    const firstReference = result.current;

    rerender();

    // Falsification: dropping the `useMemo` (or keying it on a fresh `[]`
    // literal each render) would produce a NEW array here even though
    // nothing about the underlying store changed - which would retrigger
    // every memoized consumer downstream on every render.
    expect(result.current).toBe(firstReference);
  });

  it("sorts interrupted forwards before active ones", () => {
    const session = installPortForwardChatSession();
    const active = forward({
      forwardId: "active-1",
      state: "active",
      createdAtMs: 1,
    });
    const interrupted = forward({
      forwardId: "interrupted-1",
      state: "interrupted",
      createdAtMs: 2,
    });
    session.setPortForwards([active, interrupted]);

    const { result } = renderHook(() =>
      usePortForwardsForChat({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      }),
    );

    expect(result.current.map((f) => f.forwardId)).toEqual([
      "interrupted-1",
      "active-1",
    ]);
  });

  it("orders forwards within a state by createdAtMs ascending", () => {
    const session = installPortForwardChatSession();
    const newer = forward({
      forwardId: "newer",
      state: "active",
      createdAtMs: 20,
    });
    const older = forward({
      forwardId: "older",
      state: "active",
      createdAtMs: 10,
    });
    session.setPortForwards([newer, older]);

    const { result } = renderHook(() =>
      usePortForwardsForChat({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      }),
    );

    expect(result.current.map((f) => f.forwardId)).toEqual(["older", "newer"]);
  });

  it("updates when the store's portForwards change", () => {
    const session = installPortForwardChatSession();
    session.setPortForwards([forward({ forwardId: "first" })]);

    const { result } = renderHook(() =>
      usePortForwardsForChat({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      }),
    );

    expect(result.current.map((f) => f.forwardId)).toEqual(["first"]);

    act(() => {
      session.setPortForwards([
        forward({ forwardId: "first" }),
        forward({ forwardId: "second", createdAtMs: 2 }),
      ]);
    });

    expect(result.current.map((f) => f.forwardId)).toEqual(["first", "second"]);
  });
});
