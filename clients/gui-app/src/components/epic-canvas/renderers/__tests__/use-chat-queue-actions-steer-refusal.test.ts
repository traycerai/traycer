/**
 * `use-chat-queue-actions.ts`'s steer refusal routing: a queued steer the host
 * refused until the person confirms ending the turn is asked about in the tile
 * that sent it while that tile lives. Closing it releases the question for one
 * surviving or newly opened tile. Two panes on one chat share one store, and
 * an unfocused pane renders no dialog, so a live owner's question stays there.
 */
import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatActiveTurn,
  ChatQueueSteerRestartReason,
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";

import {
  useChatQueueActions,
  type ChatQueueActionsResult,
  type ChatQueueActionsInput,
} from "@/components/epic-canvas/renderers/use-chat-queue-actions";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type SteerRestartRefusal,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const NODE_ID = "chat-queue-1";
const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function createHandle(): ChatSessionStoreHandle {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: "epic-1",
    chatId: NODE_ID,
    userId: "user-1",
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
      close: () => undefined,
    }),
  });
}

function fakeChatActions(overrides: Partial<ChatActions>): ChatActions {
  return {
    sendMessage: () => null,
    deleteMessageSuffix: () => null,
    editUserMessage: () => null,
    revertFileChanges: () => null,
    stopTurn: () => null,
    stopBackgroundItem: () => null,
    stopAllBackgroundItems: () => null,
    stopBackgroundSession: () => null,
    pauseQueue: () => null,
    resumeQueue: () => null,
    queueEdit: () => null,
    queueSettingsUpdate: () => null,
    submitQueueEdit: () => null,
    checkSendDelivery: () => undefined,
    restampQueuedItemSettings: () => undefined,
    updateActivePermissionMode: () => null,
    updateActiveProfile: () => null,
    queueCancel: () => "action-1",
    queueReorder: () => null,
    queueSteerNow: () => null,
    queueAbortSteer: () => null,
    approvalDecision: () => null,
    fileEditApprovalDecision: () => null,
    restoreCheckpoint: () => null,
    interviewAnswer: () => null,
    interviewSkip: () => null,
    interviewDeliveryRetry: () => null,
    ackFailedSendRestoration: () => undefined,
    ackAcceptedAction: () => undefined,
    takeSetupFailedRestoration: () => null,
    messageDeliveryRestored: () => null,
    ...overrides,
  };
}

function refusalFrom(
  initiatorId: string,
  clientActionId: string,
): SteerRestartRefusal {
  return {
    clientActionId,
    queueItemId: "queue-1",
    newSettings: SETTINGS,
    reasons: ["images"],
    initiatorId,
    turnId: null,
    editSettings: null,
  };
}

function tileInput(
  handle: ChatSessionStoreHandle,
  tileInstanceId: string,
  queueSteerNow: ChatActions["queueSteerNow"],
): ChatQueueActionsInput {
  return {
    chatActions: fakeChatActions({ queueSteerNow }),
    handle,
    nodeId: NODE_ID,
    tileInstanceId,
    replaceDraftContent: () => undefined,
    clearDraftContent: () => undefined,
    currentComposerSettings: SETTINGS,
    nextStepSettings: SETTINGS,
    currentEpicId: "epic-1",
    editingQueueItemId: null,
    activeEditingQueueItemId: null,
    dispatchUi: () => undefined,
    setEpicRunSettings: () => undefined,
    persistChatRunSettings: () => undefined,
  };
}

describe("steer restart refusal routing", () => {
  it("asks in the tile that sent the steer, not in an earlier pane on the same chat", () => {
    const handle = createHandle();
    const queueSteerNow = vi.fn<ChatActions["queueSteerNow"]>(() => "steer-2");
    const tileA = renderHook(() =>
      useChatQueueActions(tileInput(handle, "tile-a", queueSteerNow)),
    );
    const tileB = renderHook(() =>
      useChatQueueActions(tileInput(handle, "tile-b", queueSteerNow)),
    );

    act(() => {
      handle.store.setState({
        steerRestartRefusals: [refusalFrom("tile-b", "steer-1")],
      });
    });

    expect(tileA.result.current.steerRestart.open).toBe(false);
    expect(tileB.result.current.steerRestart.open).toBe(true);
    expect(tileB.result.current.steerRestart.reasons).toEqual(["images"]);

    act(() => {
      tileB.result.current.steerRestart.onRestart();
    });

    expect(queueSteerNow).toHaveBeenCalledWith("queue-1", SETTINGS, true, {
      initiatorId: "tile-b",
      editSettings: null,
    });
    expect(handle.store.getState().steerRestartRefusals).toEqual([]);
    expect(tileB.result.current.steerRestart.open).toBe(false);
    expect(tileA.result.current.steerRestart.open).toBe(false);
  });

  it("asks for a refusal that arrived before the sending tile rendered again", () => {
    const handle = createHandle();
    handle.store.setState({
      steerRestartRefusals: [refusalFrom("tile-b", "steer-1")],
    });

    const tileB = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );

    expect(tileB.result.current.steerRestart.open).toBe(true);

    act(() => {
      tileB.result.current.steerRestart.onOpenChange(false);
    });

    // Cancel leaves the prompt queued and the question answered.
    expect(handle.store.getState().steerRestartRefusals).toEqual([]);
    expect(tileB.result.current.steerRestart.open).toBe(false);
  });

  it("keeps another tile's question open when one tile answers its own", () => {
    const handle = createHandle();
    const tileA = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );
    const tileB = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );

    act(() => {
      handle.store.setState({
        steerRestartRefusals: [
          refusalFrom("tile-a", "steer-1"),
          refusalFrom("tile-b", "steer-2"),
        ],
      });
    });
    expect(tileA.result.current.steerRestart.open).toBe(true);
    expect(tileB.result.current.steerRestart.open).toBe(true);

    act(() => {
      tileB.result.current.steerRestart.onOpenChange(false);
    });

    expect(tileB.result.current.steerRestart.open).toBe(false);
    expect(tileA.result.current.steerRestart.open).toBe(true);
    expect(handle.store.getState().steerRestartRefusals).toEqual([
      refusalFrom("tile-a", "steer-1"),
    ]);
  });
});

const OTHER_SETTINGS: ChatRunSettings = { ...SETTINGS, model: "gpt-5-mini" };

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function runningTurn(turnId: string): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status: "running",
    harnessId: "codex",
    model: "gpt-5-codex",
    profileId: null,
    userMessageId: `message-${turnId}`,
    startedAt: 3,
    updatedAt: 3,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function queuedRow(): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "queued-message-1",
    message: {
      kind: "user",
      content: textDoc("original"),
      browserAnnotations: [],
    },
    sender: { type: "user", userId: "user-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A store whose stream this test drives, open on a running turn with one queued row. */
function openRunningChat(): OpenRunningChat {
  return openRunningChatOn(false);
}

interface OpenRunningChat {
  readonly handle: ChatSessionStoreHandle;
  readonly callbacks: ChatStreamCallbacks;
  readonly sent: ChatSubscribeClientFrame[];
}

/** Same chat, on a session that does or does not negotiate restart confirmation. */
function openRunningChatOn(
  restartConfirmationSupported: boolean,
): OpenRunningChat {
  const sent: ChatSubscribeClientFrame[] = [];
  const stream: { callbacks: ChatStreamCallbacks | null } = { callbacks: null };
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: "epic-1",
    chatId: NODE_ID,
    userId: "user-1",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      stream.callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        queuedSteerRestartConfirmationSupported: () =>
          restartConfirmationSupported,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  const callbacks = stream.callbacks;
  if (callbacks === null) throw new Error("Expected stream callbacks");
  openRunningStream(callbacks);
  return { handle, callbacks, sent };
}

/** Open the stream and seat the running turn with its one queued row. */
function openRunningStream(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: NODE_ID,
    snapshot: {
      chat: {
        id: NODE_ID,
        parentId: null,
        userId: "user-1",
        hostId: "host-a",
        title: "Host Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [queuedRow()] },
      runStatus: "running",
      activeTurn: runningTurn("turn-1"),
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
    },
  });
}

function ack(
  callbacks: ChatStreamCallbacks,
  input: {
    readonly clientActionId: string;
    readonly action: "queueEdit" | "queueSteerNow";
    readonly refusedUnconfirmed: boolean;
    readonly steerRestartReasons?: ReadonlyArray<ChatQueueSteerRestartReason>;
  },
): void {
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: NODE_ID,
    clientActionId: input.clientActionId,
    action: input.action,
    status: input.refusedUnconfirmed ? "rejected" : "accepted",
    reason: input.refusedUnconfirmed
      ? "Steering this message now would end the current turn."
      : null,
    code: input.refusedUnconfirmed ? "QUEUE_STEER_RESTART_UNCONFIRMED" : null,
    backgroundStopTaskIds: [],
    token: null,
    ...(input.refusedUnconfirmed
      ? { steerRestartReasons: [...(input.steerRestartReasons ?? ["harness"])] }
      : {}),
  });
}

describe("answering a held steer refusal", () => {
  it("does not confirm ending a turn that started after the refusal", () => {
    const { handle, callbacks } = openRunningChat();
    const steerId = handle.store
      .getState()
      .queueSteerNow("queue-1", SETTINGS, false, {
        initiatorId: "tile-a",
        editSettings: null,
      });
    if (steerId === null) throw new Error("Expected the steer to dispatch");
    ack(callbacks, {
      clientActionId: steerId,
      action: "queueSteerNow",
      refusedUnconfirmed: true,
    });
    const queueSteerNow = vi.fn<ChatActions["queueSteerNow"]>(() => "steer-2");
    const tile = renderHook(() =>
      useChatQueueActions(tileInput(handle, "tile-a", queueSteerNow)),
    );
    expect(tile.result.current.steerRestart.open).toBe(true);

    // The refused turn ends while the dialog is open and the next queued
    // prompt starts a turn of its own.
    act(() => {
      callbacks.onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: NODE_ID,
        runStatus: "running",
        activeTurn: runningTurn("turn-2"),
      });
    });
    act(() => {
      tile.result.current.steerRestart.onRestart();
    });

    // Sent again unconfirmed: the host asks about the turn now running.
    expect(queueSteerNow.mock.calls.map((call) => call[2])).toEqual([false]);
  });

  it("saves a queue edit's settings when the person declines its steer", () => {
    const { handle, callbacks } = openRunningChat();
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");
    ack(callbacks, {
      clientActionId: editId,
      action: "queueEdit",
      refusedUnconfirmed: false,
    });
    ack(callbacks, {
      clientActionId: steerId,
      action: "queueSteerNow",
      refusedUnconfirmed: true,
    });
    const queueSettingsUpdate = vi.fn<ChatActions["queueSettingsUpdate"]>(
      () => "settings-1",
    );
    const tile = renderHook(() =>
      useChatQueueActions({
        ...tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
        chatActions: fakeChatActions({ queueSettingsUpdate }),
      }),
    );
    expect(tile.result.current.steerRestart.open).toBe(true);

    act(() => {
      tile.result.current.steerRestart.onOpenChange(false);
    });

    // The text was saved; the settings rode only on the declined steer.
    expect(queueSettingsUpdate).toHaveBeenCalledWith("queue-1", OTHER_SETTINGS);
  });

  it("lets a surviving pane decline a closed initiator's refused queue edit steer", async () => {
    const { handle, callbacks, sent } = openRunningChat();
    const tileA = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );
    const tileB = renderHook(() =>
      useChatQueueActions({
        ...tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
        chatActions: fakeChatActions({
          queueSettingsUpdate: (queueItemId, settings) =>
            handle.store.getState().queueSettingsUpdate(queueItemId, settings),
        }),
      }),
    );
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");

    await act(async () => {
      tileA.unmount();
      await Promise.resolve();
    });

    act(() => {
      ack(callbacks, {
        clientActionId: editId,
        action: "queueEdit",
        refusedUnconfirmed: false,
      });
      ack(callbacks, {
        clientActionId: steerId,
        action: "queueSteerNow",
        refusedUnconfirmed: true,
      });
    });

    expect(tileB.result.current.steerRestart.open).toBe(true);

    act(() => {
      tileB.result.current.steerRestart.onOpenChange(false);
    });

    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "queueSettingsUpdate",
        queueItemId: "queue-1",
        settings: OTHER_SETTINGS,
      }),
    );
  });

  it("transfers a refusal that arrived while its initiator was live to a surviving pane", async () => {
    const { handle, callbacks, sent } = openRunningChat();
    const tileA = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );
    const tileB = renderHook(() =>
      useChatQueueActions({
        ...tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
        chatActions: fakeChatActions({
          queueSettingsUpdate: (queueItemId, settings) =>
            handle.store.getState().queueSettingsUpdate(queueItemId, settings),
        }),
      }),
    );
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");

    act(() => {
      ack(callbacks, {
        clientActionId: editId,
        action: "queueEdit",
        refusedUnconfirmed: false,
      });
      ack(callbacks, {
        clientActionId: steerId,
        action: "queueSteerNow",
        refusedUnconfirmed: true,
      });
    });
    expect(tileA.result.current.steerRestart.open).toBe(true);
    expect(tileB.result.current.steerRestart.open).toBe(false);

    await act(async () => {
      tileA.unmount();
      await Promise.resolve();
    });

    expect(tileB.result.current.steerRestart.open).toBe(true);
    act(() => {
      tileB.result.current.steerRestart.onOpenChange(false);
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "queueSettingsUpdate",
        queueItemId: "queue-1",
        settings: OTHER_SETTINGS,
      }),
    );
  });

  it("lets a later pane decline an initiator's refusal after it closes without survivors", async () => {
    const { handle, callbacks, sent } = openRunningChat();
    const tileA = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");

    await act(async () => {
      tileA.unmount();
      await Promise.resolve();
    });
    act(() => {
      ack(callbacks, {
        clientActionId: editId,
        action: "queueEdit",
        refusedUnconfirmed: false,
      });
      ack(callbacks, {
        clientActionId: steerId,
        action: "queueSteerNow",
        refusedUnconfirmed: true,
      });
    });
    const tileB = renderHook(() =>
      useChatQueueActions({
        ...tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
        chatActions: fakeChatActions({
          queueSettingsUpdate: (queueItemId, settings) =>
            handle.store.getState().queueSettingsUpdate(queueItemId, settings),
        }),
      }),
    );

    expect(tileB.result.current.steerRestart.open).toBe(true);
    act(() => {
      tileB.result.current.steerRestart.onOpenChange(false);
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "queueSettingsUpdate",
        queueItemId: "queue-1",
        settings: OTHER_SETTINGS,
      }),
    );
  });

  it("lets only one surviving pane answer a closed initiator's refusal", async () => {
    const { handle, callbacks, sent } = openRunningChat();
    const tileA = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );
    const survivingTile = (tileInstanceId: string) =>
      renderHook(() =>
        useChatQueueActions({
          ...tileInput(
            handle,
            tileInstanceId,
            vi.fn<ChatActions["queueSteerNow"]>(() => null),
          ),
          chatActions: fakeChatActions({
            queueSettingsUpdate: (queueItemId, settings) =>
              handle.store
                .getState()
                .queueSettingsUpdate(queueItemId, settings),
          }),
        }),
      );
    const tileB = survivingTile("tile-b");
    const tileC = survivingTile("tile-c");
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");

    act(() => {
      ack(callbacks, {
        clientActionId: editId,
        action: "queueEdit",
        refusedUnconfirmed: false,
      });
      ack(callbacks, {
        clientActionId: steerId,
        action: "queueSteerNow",
        refusedUnconfirmed: true,
      });
    });
    expect(tileA.result.current.steerRestart.open).toBe(true);
    expect(tileB.result.current.steerRestart.open).toBe(false);
    expect(tileC.result.current.steerRestart.open).toBe(false);

    await act(async () => {
      tileA.unmount();
      await Promise.resolve();
    });

    const openSurvivors = [tileB, tileC].filter(
      (tile) => tile.result.current.steerRestart.open,
    );
    expect(openSurvivors).toHaveLength(1);
    act(() => {
      openSurvivors[0]?.result.current.steerRestart.onOpenChange(false);
    });
    expect(
      sent.filter((frame) => frame.kind === "queueSettingsUpdate"),
    ).toHaveLength(1);
  });

  it("keeps a live initiator's refusal through StrictMode effect replay", async () => {
    const { handle, callbacks } = openRunningChat();
    const tileB = renderHook(() =>
      useChatQueueActions(
        tileInput(
          handle,
          "tile-b",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
      ),
    );
    const steerId = handle.store
      .getState()
      .queueSteerNow("queue-1", SETTINGS, false, {
        initiatorId: "tile-a",
        editSettings: null,
      });
    if (steerId === null) throw new Error("Expected the steer to dispatch");
    act(() => {
      ack(callbacks, {
        clientActionId: steerId,
        action: "queueSteerNow",
        refusedUnconfirmed: true,
      });
    });

    const tileA = renderHook(
      () =>
        useChatQueueActions(
          tileInput(
            handle,
            "tile-a",
            vi.fn<ChatActions["queueSteerNow"]>(() => null),
          ),
        ),
      { reactStrictMode: true },
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(tileA.result.current.steerRestart.open).toBe(true);
    expect(tileB.result.current.steerRestart.open).toBe(false);
  });

  it("keeps a declined queue edit's settings until the stream can carry their save", () => {
    const { handle, callbacks, sent } = openRunningChat();
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");
    ack(callbacks, {
      clientActionId: editId,
      action: "queueEdit",
      refusedUnconfirmed: false,
    });
    ack(callbacks, {
      clientActionId: steerId,
      action: "queueSteerNow",
      refusedUnconfirmed: true,
    });
    const tile = renderHook(() =>
      useChatQueueActions({
        ...tileInput(
          handle,
          "tile-a",
          vi.fn<ChatActions["queueSteerNow"]>(() => null),
        ),
        chatActions: fakeChatActions({
          queueSettingsUpdate: (queueItemId, settings) =>
            handle.store.getState().queueSettingsUpdate(queueItemId, settings),
        }),
      }),
    );
    const settingsFrames = () =>
      sent.filter((frame) => frame.kind === "queueSettingsUpdate");

    act(() => {
      callbacks.onConnectionStatus("reconnecting", null, null);
    });
    act(() => {
      tile.result.current.steerRestart.onOpenChange(false);
    });

    // Nothing could be sent, so the question, and the settings it holds, stay.
    expect(settingsFrames()).toEqual([]);
    expect(handle.store.getState().steerRestartRefusals).toHaveLength(1);
    expect(tile.result.current.steerRestart.open).toBe(true);

    act(() => {
      openRunningStream(callbacks);
    });
    act(() => {
      tile.result.current.steerRestart.onOpenChange(false);
    });

    expect(settingsFrames()).toMatchObject([
      { queueItemId: "queue-1", settings: OTHER_SETTINGS },
    ]);
    expect(handle.store.getState().steerRestartRefusals).toEqual([]);
  });

  /** A queue edit asking for other settings, text saved, steer refused, dialog open. */
  function openDialogOverRefusedEditSteer() {
    const { handle, callbacks, sent } = openRunningChat();
    const editId = handle.store.getState().submitQueueEdit({
      queueItemId: "queue-1",
      content: textDoc("edited"),
      restore: { content: textDoc("edited"), browserAnnotations: [] },
      settings: OTHER_SETTINGS,
      intent: "steer",
      steerRestartConfirmed: false,
      steerInitiatorId: "tile-a",
    });
    if (editId === null) throw new Error("Expected the edit to dispatch");
    const steerId =
      handle.store.getState().queueEditRecords[editId]?.followUpActionId;
    if (steerId === undefined) throw new Error("Expected the edit's steer");
    ack(callbacks, {
      clientActionId: editId,
      action: "queueEdit",
      refusedUnconfirmed: false,
    });
    ack(callbacks, {
      clientActionId: steerId,
      action: "queueSteerNow",
      refusedUnconfirmed: true,
    });
    const tile = renderHook(() =>
      useChatQueueActions({
        ...tileInput(handle, "tile-a", () => null),
        chatActions: fakeChatActions({
          queueSettingsUpdate: (queueItemId, settings) =>
            handle.store.getState().queueSettingsUpdate(queueItemId, settings),
          queueSteerNow: (queueItemId, settings, confirmed, origin) =>
            handle.store
              .getState()
              .queueSteerNow(queueItemId, settings, confirmed, origin),
        }),
      }),
    );
    expect(tile.result.current.steerRestart.open).toBe(true);
    return { handle, sent, tile, editId };
  }

  it("follows the settings save the Cancel sent, not the declined steer", () => {
    const { handle, sent, tile, editId } = openDialogOverRefusedEditSteer();

    act(() => {
      tile.result.current.steerRestart.onOpenChange(false);
    });

    const saveFrame = sent.at(-1);
    if (saveFrame?.kind !== "queueSettingsUpdate") {
      throw new Error("Expected the Cancel to send queueSettingsUpdate");
    }
    expect(handle.store.getState().queueEditRecords[editId]).toMatchObject({
      followUpActionId: saveFrame.clientActionId,
      intent: "save",
      followUp: "pending",
    });
  });

  it("follows the confirmed steer the Restart sent, not the declined one", () => {
    const { handle, sent, tile, editId } = openDialogOverRefusedEditSteer();

    act(() => {
      tile.result.current.steerRestart.onRestart();
    });

    const steerFrame = sent.at(-1);
    if (steerFrame?.kind !== "queueSteerNow") {
      throw new Error("Expected the Restart to send queueSteerNow");
    }
    expect(handle.store.getState().queueEditRecords[editId]).toMatchObject({
      followUpActionId: steerFrame.clientActionId,
      intent: "steer",
      followUp: "pending",
    });
  });
});

describe("steering a queued prompt from the row", () => {
  // A running turn on another model than the composer's next-step settings.
  function steerFromRow(chat: OpenRunningChat): {
    readonly row: RenderHookResult<ChatQueueActionsResult, unknown>;
    readonly steerFrames: () => Extract<
      ChatSubscribeClientFrame,
      { kind: "queueSteerNow" }
    >[];
  } {
    const row = renderHook(() =>
      useChatQueueActions({
        ...tileInput(
          chat.handle,
          "tile-a",
          (queueItemId, newSettings, restartConfirmed, origin) =>
            chat.handle.store
              .getState()
              .queueSteerNow(
                queueItemId,
                newSettings,
                restartConfirmed,
                origin,
              ),
        ),
        nextStepSettings: OTHER_SETTINGS,
      }),
    );
    const item = chat.handle.store.getState().queue.items[0];
    if (item.kind !== "prompt") {
      throw new Error("Expected the queued prompt");
    }
    act(() => {
      row.result.current.steerQueuedItemNow(item);
    });
    return {
      row,
      steerFrames: () =>
        chat.sent.flatMap((frame) =>
          frame.kind === "queueSteerNow" ? [frame] : [],
        ),
    };
  }

  it("sends a model change unconfirmed on a host that asks for restarts, then asks only if the host refuses", () => {
    const chat = openRunningChatOn(true);
    const { row, steerFrames } = steerFromRow(chat);

    expect(steerFrames()).toEqual([
      expect.objectContaining({
        newSettings: OTHER_SETTINGS,
        restartConfirmed: false,
      }),
    ]);
    expect(row.result.current.steerRestart.open).toBe(false);

    const [frame] = steerFrames();
    act(() => {
      ack(chat.callbacks, {
        clientActionId: frame.clientActionId,
        action: "queueSteerNow",
        refusedUnconfirmed: true,
        steerRestartReasons: ["images"],
      });
    });

    expect(row.result.current.steerRestart.open).toBe(true);
    expect(row.result.current.steerRestart.reasons).toEqual(["images"]);
  });

  it("does not ask when the host accepts the steer as a next-turn fallback", () => {
    const chat = openRunningChatOn(true);
    const { row, steerFrames } = steerFromRow(chat);
    const [frame] = steerFrames();

    act(() => {
      ack(chat.callbacks, {
        clientActionId: frame.clientActionId,
        action: "queueSteerNow",
        refusedUnconfirmed: false,
      });
    });

    expect(row.result.current.steerRestart.open).toBe(false);
    expect(chat.handle.store.getState().steerRestartRefusals).toEqual([]);
  });

  it("asks locally about a model change on a host that predates restart confirmation, sending nothing yet", () => {
    const chat = openRunningChatOn(false);
    const { row, steerFrames } = steerFromRow(chat);

    expect(row.result.current.steerRestart.open).toBe(true);
    expect(row.result.current.steerRestart.changed).toContain("model");
    expect(steerFrames()).toEqual([]);
  });
});
