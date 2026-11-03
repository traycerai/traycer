import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatMessageDelivery,
  ChatMessageDeliveryState,
} from "@traycer/protocol/host/agent/gui/message-delivery";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { useEpicCreateSeedHoldDriver } from "@/hooks/chats/use-epic-create-seed-hold-driver";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  clearEpicCreateSeedPending,
  markEpicCreateSeedPending,
} from "@/lib/worktree/pending-epic-create-seeds";

const EPIC_ID = "epic-hold-driver";
const CHAT_ID = "chat-hold-driver";
const SIBLING_CHAT_ID = "chat-hold-sibling";
const SEEDED_MESSAGE_ID = "msg-seeded";
const OWNER_ID = "owner-hold-driver";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

afterEach(() => {
  clearEpicCreateSeedPending(EPIC_ID, CHAT_ID);
  clearEpicCreateSeedPending(EPIC_ID, SIBLING_CHAT_ID);
});

function createHandle(chatId: string) {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      // `false`, not `true`: this suite is about the seed hold, and nothing in
      // it sends an attachment. Answering `true` would have the store report a
      // bridge no case here exercises, which is a claim rather than a default.
      draftBlobBridgeSupported: () => false,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
}

function promptItem(
  messageId: string,
  status: ChatQueuedPromptItem["status"],
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: `queue-${messageId}`,
    messageId,
    message: {
      kind: "user",
      content: CONTENT,
      browserAnnotations: [],
    },
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status,
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function setupEvent(
  type: ChatEvent["type"],
  metadata: Record<string, unknown>,
  timestamp: number,
): ChatEvent {
  return {
    eventId: `event-${type}-${timestamp}`,
    type,
    timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata,
  };
}

function creatingEvent(
  triggeringMessageId: string,
  timestamp: number,
): ChatEvent {
  return setupEvent(
    "setup.creating",
    {
      workspacePath: "/repo",
      branch: "feat",
      triggeringMessageId,
    },
    timestamp,
  );
}

const STARTED: ChatMessageDeliveryState = {
  phase: "started",
  turnId: "turn-1",
  assistantMessageId: "assistant-1",
};

function delivery(
  messageId: string,
  revision: number,
  state: ChatMessageDeliveryState,
): ChatMessageDelivery {
  return { messageId, revision, state };
}

describe("useEpicCreateSeedHoldDriver", () => {
  it("holds while snapshotLoaded is false even with an empty queue, and releases once the snapshot loads with no seeded row", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(released.length + 1);
      },
    });

    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(handle.store.getState().snapshotLoaded).toBe(false);
    expect(handle.store.getState().queue.items).toEqual([]);
    expect(released).toEqual([]);

    act(() => {
      handle.store.setState({ snapshotLoaded: true });
    });
    expect(released).toEqual([1]);
  });

  it("holds while the seeded message is queued as pending and the card is creating", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
        events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
      });
    });

    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);
  });

  it("holds while the seeded message is queued as paused and the card is creating", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "paused",
          items: [promptItem(SEEDED_MESSAGE_ID, "paused")],
        },
        events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
      });
    });

    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);

    act(() => {
      handle.store.setState({
        events: [
          creatingEvent(SEEDED_MESSAGE_ID, 1),
          setupEvent(
            "setup.running",
            { workspacePath: "/repo", terminalSessionId: "t1" },
            2,
          ),
        ],
      });
    });
    expect(released).toEqual([1]);
  });

  it("holds when the seeded row is queued and no setup card row exists yet", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
        events: [],
      });
    });

    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);
  });

  it("releases on setting-up, ready, failed, and cancelled", () => {
    const outcomes: ReadonlyArray<{
      readonly type: ChatEvent["type"];
      readonly metadata: Record<string, unknown>;
    }> = [
      {
        type: "setup.running",
        metadata: { workspacePath: "/repo", terminalSessionId: "t1" },
      },
      { type: "setup.succeeded", metadata: { workspacePath: "/repo" } },
      {
        type: "setup.failed",
        metadata: { workspacePath: "/repo", setupExitCode: 1 },
      },
      { type: "setup.cancelled", metadata: { workspacePath: "/repo" } },
    ];

    for (const outcome of outcomes) {
      const handle = createHandle(CHAT_ID);
      const released: number[] = [];
      markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
        hostId: "host-a",
        seededMessageId: SEEDED_MESSAGE_ID,
        seedRows: true,
        heldForDeferredCreate: true,
        release: () => {
          released.push(1);
        },
      });
      act(() => {
        handle.store.setState({
          snapshotLoaded: true,
          queue: {
            status: "running",
            items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
          },
          events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
        });
      });
      renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
      expect(released).toEqual([]);

      act(() => {
        handle.store.setState({
          events: [
            creatingEvent(SEEDED_MESSAGE_ID, 1),
            setupEvent(outcome.type, outcome.metadata, 2),
          ],
        });
      });
      expect(released).toEqual([1]);
      clearEpicCreateSeedPending(EPIC_ID, CHAT_ID);
    }
  });

  it("with no delivery record, falls back to the queue and releases when the seeded row has left it", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
        events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
      });
    });
    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);

    act(() => {
      handle.store.setState({
        queue: { status: "idle", items: [] },
      });
    });
    expect(released).toEqual([1]);
  });

  it("releases when there is no seeded row at all (silent synchronous fallback)", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: null,
      seedRows: false,
      heldForDeferredCreate: false,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({ snapshotLoaded: true });
    });
    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([1]);
  });

  it("takes the last row with the seeded triggeringMessageId: a failed window followed by a creating one holds", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
        events: [
          creatingEvent(SEEDED_MESSAGE_ID, 1),
          setupEvent(
            "setup.failed",
            { workspacePath: "/repo", setupExitCode: 1 },
            2,
          ),
          creatingEvent(SEEDED_MESSAGE_ID, 3),
        ],
      });
    });
    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);
  });

  it("releases a failed window that was not followed by a creating retry (positive control for last-row)", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
        events: [
          creatingEvent(SEEDED_MESSAGE_ID, 1),
          setupEvent(
            "setup.failed",
            { workspacePath: "/repo", setupExitCode: 1 },
            2,
          ),
        ],
      });
    });
    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([1]);
  });

  it("releases exactly once across repeated store changes", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(released.length + 1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
        events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
      });
    });
    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);

    act(() => {
      handle.store.setState({
        events: [
          creatingEvent(SEEDED_MESSAGE_ID, 1),
          setupEvent("setup.succeeded", { workspacePath: "/repo" }, 2),
        ],
      });
    });
    expect(released).toEqual([1]);

    act(() => {
      handle.store.setState({
        queue: { status: "idle", items: [] },
      });
    });
    act(() => {
      handle.store.setState({
        events: [
          creatingEvent(SEEDED_MESSAGE_ID, 1),
          setupEvent("setup.succeeded", { workspacePath: "/repo" }, 2),
          setupEvent("turn.started", {}, 3),
        ],
      });
    });
    expect(released).toEqual([1]);
  });

  it("a sibling chat tile that owns no entry releases nothing even when it would otherwise match", () => {
    const sibling = createHandle(SIBLING_CHAT_ID);
    const owner = createHandle(CHAT_ID);
    const released: string[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push("owner");
      },
    });
    act(() => {
      sibling.store.setState({ snapshotLoaded: true });
      owner.store.setState({ snapshotLoaded: true });
    });

    renderHook(() => useEpicCreateSeedHoldDriver({ handle: sibling }));
    expect(released).toEqual([]);

    renderHook(() => useEpicCreateSeedHoldDriver({ handle: owner }));
    expect(released).toEqual(["owner"]);
  });

  describe("when the delivery record names the seeded message", () => {
    function markHeldSeed(): number[] {
      const released: number[] = [];
      markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
        hostId: "host-a",
        seededMessageId: SEEDED_MESSAGE_ID,
        seedRows: true,
        heldForDeferredCreate: true,
        release: () => {
          released.push(1);
        },
      });
      return released;
    }

    it("holds through pending and preparing with an empty queue, and releases at started", () => {
      const handle = createHandle(CHAT_ID);
      const released = markHeldSeed();
      act(() => {
        handle.store.setState({
          snapshotLoaded: true,
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 1, { phase: "pending" }),
        });
      });
      renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
      expect(released).toEqual([]);

      act(() => {
        handle.store.setState({
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 2, {
            phase: "preparing",
          }),
          events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
        });
      });
      expect(released).toEqual([]);

      act(() => {
        handle.store.setState({
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 3, STARTED),
        });
      });
      expect(released).toEqual([1]);
    });

    it("releases on withdrawn", () => {
      const handle = createHandle(CHAT_ID);
      const released = markHeldSeed();
      act(() => {
        handle.store.setState({
          snapshotLoaded: true,
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 1, {
            phase: "preparing",
          }),
          events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
        });
      });
      renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
      expect(released).toEqual([]);

      act(() => {
        handle.store.setState({
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 2, {
            phase: "withdrawn",
            code: "WORKTREE_SETUP_FAILED",
            reason: "git worktree add failed",
            missingHashes: [],
            restore: null,
            restoreClaimed: false,
          }),
        });
      });
      expect(released).toEqual([1]);
    });

    it("releases during preparing once the card row reaches setting-up, because the add is done", () => {
      const handle = createHandle(CHAT_ID);
      const released = markHeldSeed();
      act(() => {
        handle.store.setState({
          snapshotLoaded: true,
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 1, {
            phase: "preparing",
          }),
          events: [creatingEvent(SEEDED_MESSAGE_ID, 1)],
        });
      });
      renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
      expect(released).toEqual([]);

      act(() => {
        handle.store.setState({
          events: [
            creatingEvent(SEEDED_MESSAGE_ID, 1),
            setupEvent(
              "setup.running",
              { workspacePath: "/repo", terminalSessionId: "t1" },
              2,
            ),
          ],
        });
      });
      expect(released).toEqual([1]);
    });

    it("outranks a queue item carrying the same message: started releases while it is still queued", () => {
      const handle = createHandle(CHAT_ID);
      const released = markHeldSeed();
      act(() => {
        handle.store.setState({
          snapshotLoaded: true,
          messageDelivery: delivery(SEEDED_MESSAGE_ID, 1, STARTED),
          queue: {
            status: "running",
            items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
          },
        });
      });
      renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
      expect(released).toEqual([1]);
    });
  });

  it("a delivery naming a different message falls back to the queue: holds while queued, releases once it has left", () => {
    const handle = createHandle(CHAT_ID);
    const released: number[] = [];
    markEpicCreateSeedPending(EPIC_ID, CHAT_ID, {
      hostId: "host-a",
      seededMessageId: SEEDED_MESSAGE_ID,
      seedRows: true,
      heldForDeferredCreate: true,
      release: () => {
        released.push(1);
      },
    });
    act(() => {
      handle.store.setState({
        snapshotLoaded: true,
        messageDelivery: delivery("msg-other", 1, STARTED),
        queue: {
          status: "running",
          items: [promptItem(SEEDED_MESSAGE_ID, "pending")],
        },
      });
    });
    renderHook(() => useEpicCreateSeedHoldDriver({ handle }));
    expect(released).toEqual([]);

    act(() => {
      handle.store.setState({ queue: { status: "idle", items: [] } });
    });
    expect(released).toEqual([1]);
  });
});
