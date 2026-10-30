/**
 * The send's own record (`pendingTurn`) and its placement, driven through a
 * REAL store with scripted host frames. Each case runs on a host that
 * publishes `sendWouldQueue` and, where the claim differs, on an older host
 * that does not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatActivityIndicator,
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Chat, Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatRunSettings,
  ChatSubscribeClientFrame,
  ChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  queueWithDrainingPrompts,
  resolveTurnPresentation,
} from "@/stores/chats/chat-send-state";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-pending-turn";
const CHAT_ID = "chat-pending-turn";
const OWNER_ID = "owner-pending-turn";
const HOST_ID = "host-pending-turn";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
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
        sendAction: (frame) => {
          sent.push(frame);
        },
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
    sent,
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
  };
}

interface HostFacts {
  readonly runStatus: "idle" | "running";
  readonly turnInProgress: boolean | undefined;
  readonly sendWouldQueue: boolean | undefined;
}

const IDLE_HOST: HostFacts = {
  runStatus: "idle",
  turnInProgress: false,
  sendWouldQueue: false,
};

/** A new host busy with background work only: running, no turn, no queue. */
const BACKGROUND_ONLY_HOST: HostFacts = {
  runStatus: "running",
  turnInProgress: false,
  sendWouldQueue: false,
};

/** An older host publishes neither `turnInProgress` nor `sendWouldQueue`. */
const OLDER_HOST_IDLE: HostFacts = {
  runStatus: "idle",
  turnInProgress: undefined,
  sendWouldQueue: undefined,
};

function emitSnapshot(callbacks: ChatStreamCallbacks, host: HostFacts): void {
  emitSnapshotWith(callbacks, host, [], null);
}

function emitSnapshotWith(
  callbacks: ChatStreamCallbacks,
  host: HostFacts,
  savedMessageIds: ReadonlyArray<string>,
  activeTurn: ChatActiveTurn | null,
): void {
  emitSnapshotWithQueue(callbacks, host, {
    savedMessageIds,
    activeTurn,
    queuedMessageIds: [],
  });
}

function emitSnapshotWithQueue(
  callbacks: ChatStreamCallbacks,
  host: HostFacts,
  {
    savedMessageIds,
    activeTurn,
    queuedMessageIds,
  }: {
    readonly savedMessageIds: ReadonlyArray<string>;
    readonly activeTurn: ChatActiveTurn | null;
    readonly queuedMessageIds: ReadonlyArray<string>;
  },
): void {
  callbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        ...emptyChat(),
        messages: savedMessageIds.map((id) => savedUserMessage(id)),
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: {
        status: queuedMessageIds.length > 0 ? "running" : "idle",
        items: queuedMessageIds.map((id) => queuedPromptItem(id)),
      },
      runStatus: host.runStatus,
      turnInProgress: host.turnInProgress,
      sendWouldQueue: host.sendWouldQueue,
      activeTurn,
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

function sendPrompt(harness: Harness): {
  readonly clientActionId: string;
  readonly messageId: string;
} {
  const action = harness.handle.store.getState().sendMessage({
    content: CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: [],
    deliveryPolicy: "auto",
    restore: { content: CONTENT, browserAnnotations: [] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  return action;
}

/**
 * Acceptance carries a user message, not the broader transcript Message union.
 */
type AcceptedMessage = Parameters<
  ChatStreamCallbacks["onMessageAccepted"]
>[0]["message"];

function acceptedMessage(
  messageId: string,
  timestamp: number,
): AcceptedMessage {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function savedUserMessage(
  messageId: string,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp: 10,
    sessionAnchor: null,
  };
}

function emitMessageAccepted(
  callbacks: ChatStreamCallbacks,
  message: AcceptedMessage,
): void {
  callbacks.onMessageAccepted({
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    message,
  });
}

function queuedPromptItem(messageId: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: `queue-${messageId}`,
    messageId,
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function emitQueueChanged(
  callbacks: ChatStreamCallbacks,
  items: ChatQueuedPromptItem[],
): void {
  callbacks.onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: items.length > 0 ? "running" : "idle", items },
  });
}

function turnFor(messageId: string | null, turnId: string): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status: "starting",
    harnessId: "claude",
    model: "claude-sonnet-4-5",
    profileId: null,
    userMessageId: messageId,
    startedAt: 5_000,
    updatedAt: 5_000,
    reasoningEffort: null,
    serviceTier: null,
  };
}

interface TurnFrameInput {
  readonly runStatus: "idle" | "running";
  readonly activeTurn: ChatActiveTurn | null;
  readonly turnInProgress: boolean | undefined;
  readonly sendWouldQueue: boolean | undefined;
}

function emitTurnState(
  callbacks: ChatStreamCallbacks,
  input: TurnFrameInput,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: input.runStatus,
    activeTurn: input.activeTurn,
    turnInProgress: input.turnInProgress,
    sendWouldQueue: input.sendWouldQueue,
  });
}

function emitAck(
  harness: Harness,
  clientActionId: string,
  status: "accepted" | "rejected",
): void {
  const frame = harness.sent.find(
    (candidate) =>
      candidate.kind !== "ping" &&
      "clientActionId" in candidate &&
      candidate.clientActionId === clientActionId,
  );
  if (frame === undefined || !("clientActionId" in frame)) {
    throw new Error("Expected the action frame");
  }
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: frame.kind,
    status,
    reason: status === "rejected" ? "rejected by host" : null,
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function framesOfKind(
  harness: Harness,
  kind: string,
): ChatSubscribeClientFrame[] {
  return harness.sent.filter((frame) => frame.kind === kind);
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
});

function openHarness(host: HostFacts): Harness {
  const opened = createHarness();
  harness = opened;
  emitSnapshot(opened.callbacks(), host);
  return opened;
}

function stateOf(opened: Harness) {
  return opened.handle.store.getState();
}

function promptIds(opened: Harness): string[] {
  return stateOf(opened).queue.items.flatMap((item) =>
    item.kind === "prompt" ? [item.messageId] : [],
  );
}

function expectPendingTurn(
  opened: Harness,
  messageId: string,
  sentAt: number | null,
): void {
  const turn = stateOf(opened).pendingTurn;
  expect(turn?.messageId).toBe(messageId);
  expect(turn?.settings).toEqual(SETTINGS);
  if (sentAt === null) {
    expect(typeof turn?.sentAt).toBe("number");
  } else {
    expect(turn?.sentAt).toBe(sentAt);
  }
}

describe("a send's placement and its pendingTurn on a new host", () => {
  it("an idle chat takes the transcript and starts a pendingTurn from the send itself", () => {
    const opened = openHarness(IDLE_HOST);
    const before = Date.now();

    const sent = sendPrompt(opened);

    const state = stateOf(opened);
    expect(state.pendingUserMessages.map((m) => m.messageId)).toEqual([
      sent.messageId,
    ]);
    expect(state.queue.items).toEqual([]);
    expectPendingTurn(opened, sent.messageId, null);
    expect(state.pendingTurn?.sentAt).toBeGreaterThanOrEqual(before);
  });

  it("a chat busy only with background work (running, no turn) takes the transcript too", () => {
    const opened = openHarness(BACKGROUND_ONLY_HOST);

    const sent = sendPrompt(opened);

    const state = stateOf(opened);
    expect(state.pendingUserMessages.map((m) => m.messageId)).toEqual([
      sent.messageId,
    ]);
    expect(state.queue.items).toEqual([]);
    expect(state.pendingTurn?.messageId).toBe(sent.messageId);
  });

  it("sendWouldQueue docks the send with no pendingTurn, however idle the local state reads", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });

    const sent = sendPrompt(opened);

    const state = stateOf(opened);
    expect(state.pendingUserMessages).toEqual([]);
    expect(promptIds(opened)).toEqual([sent.messageId]);
    expect(state.pendingTurn).toBeNull();
  });

  it("a live turn does not dock the send while the host says it would not queue", () => {
    const opened = openHarness(IDLE_HOST);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor("message-earlier", "turn-earlier"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    sendPrompt(opened);

    expect(stateOf(opened).queue.items).toEqual([]);
    expect(stateOf(opened).pendingUserMessages).toHaveLength(1);
  });

  it("sendWouldQueue arriving on a turn-state frame changes the next placement", () => {
    const opened = openHarness(IDLE_HOST);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: true,
    });

    sendPrompt(opened);

    expect(stateOf(opened).queue.items).toHaveLength(1);
    expect(stateOf(opened).pendingUserMessages).toEqual([]);
  });

  it("the optimistic dock row maps the delivery policy onto the wire delivery (after_turn is next_turn)", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });

    const action = stateOf(opened).sendMessage({
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: [],
      deliveryPolicy: "after_turn",
      restore: { content: CONTENT, browserAnnotations: [] },
    });

    expect(action).not.toBeNull();
    const row = stateOf(opened).queue.items[0];
    expect(row.kind === "prompt" ? row.delivery : null).toBe("next_turn");
  });
});

describe("a send's placement on an older host", () => {
  it("background work alone (running, no turn, no queue) takes the transcript", () => {
    const opened = openHarness({
      ...OLDER_HOST_IDLE,
      runStatus: "running",
    });

    const sent = sendPrompt(opened);

    expect(stateOf(opened).pendingUserMessages.map((m) => m.messageId)).toEqual(
      [sent.messageId],
    );
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
  });

  it("an active turn docks the send", () => {
    const opened = openHarness(OLDER_HOST_IDLE);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor("message-earlier", "turn-earlier"),
      turnInProgress: undefined,
      sendWouldQueue: undefined,
    });

    sendPrompt(opened);

    expect(stateOf(opened).queue.items).toHaveLength(1);
    expect(stateOf(opened).pendingUserMessages).toEqual([]);
    expect(stateOf(opened).pendingTurn).toBeNull();
  });
});

describe("a send on an older host while another sender's prompt is carried", () => {
  function carryRemotePrompt(): Harness {
    const opened = openHarness(OLDER_HOST_IDLE);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem("remote-a")]);
    emitQueueChanged(opened.callbacks(), []);
    expect(
      stateOf(opened).drainingQueueItems?.map((item) => item.messageId),
    ).toEqual(["remote-a"]);
    expect(stateOf(opened).pendingTurn).toBeNull();
    expect(stateOf(opened).activeTurn).toBeNull();
    expect(Object.keys(stateOf(opened).pendingActions)).toEqual([]);
    return opened;
  }

  it("docks the send while the carry is the only evidence of the host's turn", () => {
    const opened = carryRemotePrompt();

    const sent = sendPrompt(opened);

    expect(promptIds(opened)).toEqual([sent.messageId]);
    expect(stateOf(opened).pendingUserMessages).toEqual([]);
    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("places the send in the transcript with its own pendingTurn once the host says sendWouldQueue is false", () => {
    const opened = carryRemotePrompt();
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: undefined,
      sendWouldQueue: false,
    });

    const sent = sendPrompt(opened);

    expect(stateOf(opened).pendingUserMessages.map((m) => m.messageId)).toEqual(
      [sent.messageId],
    );
    expect(promptIds(opened)).toEqual([]);
    expectPendingTurn(opened, sent.messageId, null);
  });
});

describe("pendingTurn lifecycle", () => {
  it("keeps sentAt across the host's ack and acceptance", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    const sentAt = stateOf(opened).pendingTurn?.sentAt;
    expect(sentAt).toBeDefined();

    emitAck(opened, sent.clientActionId, "accepted");
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );

    expect(stateOf(opened).acceptedActions[sent.clientActionId]?.sentAt).toBe(
      sentAt,
    );
    expect(stateOf(opened).pendingTurn).toEqual({
      messageId: sent.messageId,
      sentAt,
      settings: SETTINGS,
    });
  });

  it("is suspended when the host queues a send the GUI placed in the transcript", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);

    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    expect(stateOf(opened).pendingTurn).toBeNull();
    expect(stateOf(opened).pendingUserMessages).toEqual([]);
    expect(promptIds(opened)).toEqual([sent.messageId]);
  });

  it("a docked send gets its pendingTurn when activeTurn names its message, keeping the send's own settings and the original sentAt", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    expect(stateOf(opened).pendingTurn).toBeNull();

    emitQueueChanged(opened.callbacks(), []);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expectPendingTurn(opened, sent.messageId, null);
  });

  it("a docked send gets its pendingTurn when messageAccepted names it", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);

    emitQueueChanged(opened.callbacks(), []);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );

    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
  });

  it("a docked send on an older host that ran it immediately (no queue.added ever) gets its pendingTurn from messageAccepted", () => {
    const opened = openHarness(OLDER_HOST_IDLE);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor("message-earlier", "turn-earlier"),
      turnInProgress: undefined,
      sendWouldQueue: undefined,
    });
    const sent = sendPrompt(opened);
    expect(stateOf(opened).pendingTurn).toBeNull();

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: undefined,
      sendWouldQueue: undefined,
    });
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );

    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
  });

  it("stays through activation and the running turn, and ends when the turn ends", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("ends when the host rejects the send", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);

    emitAck(opened, sent.clientActionId, "rejected");

    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("ends when a turn-state frame shows the saved send settled without its turn being seen (new host)", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("ends on the same evidence on an older host: no turn in progress, no activeTurn, not queued", () => {
    const opened = openHarness(OLDER_HOST_IDLE);
    const sent = sendPrompt(opened);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: undefined,
    });

    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("does not end early on a live connection while the host still shows the turn activating", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
  });

  it("does not end before the saved row has been shown, whatever a turn-state frame says", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
  });

  it("ends on the reconnect snapshot of a turn that started and ended while disconnected: the saved row, no activeTurn", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitSnapshotWith(opened.callbacks(), IDLE_HOST, [sent.messageId], null);

    expect(stateOf(opened).pendingTurn).toBeNull();
    expect(stateOf(opened).heldStop).toBeNull();
    expect(framesOfKind(opened, "stop")).toEqual([]);
  });

  it("ends on a reconnect snapshot that carries the saved row and another turn running", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitSnapshotWith(
      opened.callbacks(),
      { ...IDLE_HOST, runStatus: "running", turnInProgress: true },
      [sent.messageId],
      turnFor("someone-elses-message", "turn-other"),
    );

    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("ends on the same snapshot on an older host only when no turn is in progress", () => {
    const opened = openHarness(OLDER_HOST_IDLE);
    const sent = sendPrompt(opened);
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitSnapshotWith(
      opened.callbacks(),
      { ...OLDER_HOST_IDLE, turnInProgress: true, runStatus: "running" },
      [sent.messageId],
      null,
    );
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);

    emitSnapshotWith(
      opened.callbacks(),
      { ...OLDER_HOST_IDLE, turnInProgress: false },
      [sent.messageId],
      null,
    );
    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("does not settle on a reconnect snapshot that has the saved row but still names the send in the queue", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitSnapshotWithQueue(
      opened.callbacks(),
      { ...IDLE_HOST, sendWouldQueue: true },
      {
        savedMessageIds: [sent.messageId],
        activeTurn: null,
        queuedMessageIds: [sent.messageId],
      },
    );

    expect(stateOf(opened).queue.items).toHaveLength(1);
    expect(stateOf(opened).pendingTurn?.messageId).not.toBeUndefined();
  });

  it("does not settle an older host's snapshot while its activation reads as in progress (turnInProgress absent, run still running), and settles once it reads idle", () => {
    const opened = openHarness(OLDER_HOST_IDLE);
    const sent = sendPrompt(opened);
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitSnapshotWith(
      opened.callbacks(),
      { ...OLDER_HOST_IDLE, runStatus: "running" },
      [sent.messageId],
      null,
    );
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);

    emitSnapshotWith(
      opened.callbacks(),
      OLDER_HOST_IDLE,
      [sent.messageId],
      null,
    );
    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("keeps the pendingTurn across a reconnect snapshot that still shows the turn naming the send", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitSnapshotWith(
      opened.callbacks(),
      { ...IDLE_HOST, runStatus: "running", turnInProgress: true },
      [sent.messageId],
      turnFor(sent.messageId, "turn-1"),
    );

    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
  });
});

describe("Stop while the send owns its turn", () => {
  function stopFrames(opened: Harness) {
    return framesOfKind(opened, "stop");
  }

  it("holds a Stop pressed before the host names the send: nothing goes on the wire", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);

    stateOf(opened).stopTurn();

    expect(stopFrames(opened)).toEqual([]);
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);
    expect(typeof stateOf(opened).heldStop?.clientActionId).toBe("string");
  });

  it("releases the held Stop as a stop naming the turn once activeTurn names the send", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-1" });
    expect(stateOf(opened).heldStop).toBeNull();
  });

  it("never lets a held Stop name another send's turn", () => {
    const opened = openHarness(IDLE_HOST);
    sendPrompt(opened);
    stateOf(opened).stopTurn();

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(null, "turn-autonomous"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expect(stopFrames(opened)).toEqual([]);
    expect(stateOf(opened).heldStop).not.toBeNull();
  });

  it("becomes a queue cancel naming the queue item once the host queues the send", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();

    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    const cancels = framesOfKind(opened, "queueCancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      queueItemId: `queue-${sent.messageId}`,
    });
    expect(stopFrames(opened)).toEqual([]);
    // The intent is retained until the host accepts the cancel: a stale
    // cancel can still lose to the activation it raced.
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);
    const cancel = cancels[0];
    if (cancel.kind !== "queueCancel") {
      throw new Error("Expected the queueCancel frame");
    }

    emitAck(opened, cancel.clientActionId, "accepted");

    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);
  });

  it("is dropped, and nothing is sent, when the host rejects the send", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();

    emitAck(opened, sent.clientActionId, "rejected");

    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);
  });

  it("is dropped, and nothing is sent, when the send settles without its turn being seen", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);
  });

  it("goes out as today against an older host: at once, naming no turn", () => {
    const opened = openHarness(OLDER_HOST_IDLE);
    sendPrompt(opened);

    stateOf(opened).stopTurn();

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: null });
    expect(stateOf(opened).heldStop).toBeNull();
  });
});

describe("a held Stop whose send the host queues and then starts before the cancel is processed", () => {
  const FATAL: Parameters<ChatStreamCallbacks["onConnectionStatus"]>[1] = {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "test close",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };

  function stopFrames(opened: Harness) {
    return framesOfKind(opened, "stop");
  }

  /** Send B, hold Stop, let the host queue B: the automatic cancel goes out. */
  function cancelOutstanding(): {
    readonly opened: Harness;
    readonly sent: {
      readonly clientActionId: string;
      readonly messageId: string;
    };
    readonly cancelActionId: string;
  } {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    const cancels = framesOfKind(opened, "queueCancel");
    expect(cancels).toHaveLength(1);
    const cancel = cancels[0];
    if (cancel.kind !== "queueCancel") {
      throw new Error("Expected the queueCancel frame");
    }
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);
    return { opened, sent, cancelActionId: cancel.clientActionId };
  }

  function startTurn(opened: Harness, messageId: string, turnId: string): void {
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(messageId, turnId),
      turnInProgress: true,
      sendWouldQueue: false,
    });
  }

  it("stops the send's turn when the turn is named first and the stale cancel is rejected after", () => {
    const { opened, sent, cancelActionId } = cancelOutstanding();

    startTurn(opened, sent.messageId, "turn-b");
    emitAck(opened, cancelActionId, "rejected");

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-b" });
  });

  it("stops the send's turn when the stale cancel is rejected first and the turn is named after", () => {
    const { opened, sent, cancelActionId } = cancelOutstanding();

    emitAck(opened, cancelActionId, "rejected");
    startTurn(opened, sent.messageId, "turn-b");

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-b" });
  });

  it("sends no stop when the cancel is accepted and the prompt leaves the queue", () => {
    const { opened, cancelActionId } = cancelOutstanding();

    emitAck(opened, cancelActionId, "accepted");
    emitQueueChanged(opened.callbacks(), []);
    startTurn(opened, "message-later", "turn-later");

    expect(stopFrames(opened)).toEqual([]);
  });

  it("never stops an unrelated turn after the cancel is rejected", () => {
    const { opened, cancelActionId } = cancelOutstanding();

    emitAck(opened, cancelActionId, "rejected");
    startTurn(opened, "message-unrelated", "turn-unrelated");

    expect(stopFrames(opened)).toEqual([]);
  });

  it("sends no stop for a send the host rejected", () => {
    const { opened, sent, cancelActionId } = cancelOutstanding();

    emitAck(opened, sent.clientActionId, "rejected");
    emitAck(opened, cancelActionId, "rejected");
    startTurn(opened, sent.messageId, "turn-b");

    expect(stopFrames(opened)).toEqual([]);
  });

  it("stops the send's turn when the queue row is removed before the cancel ack and the matching turn then activates", () => {
    const { opened, sent } = cancelOutstanding();

    emitQueueChanged(opened.callbacks(), []);
    expect(stopFrames(opened)).toEqual([]);
    startTurn(opened, sent.messageId, "turn-b");

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-b" });
  });

  it("releases the intent on a fresh idle host frame when the saved row arrived without any turn naming it", () => {
    const { opened, sent } = cancelOutstanding();

    emitQueueChanged(opened.callbacks(), []);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );
    expect(stateOf(opened).heldStop).not.toBeNull();
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);
  });

  it("discharges the intent when the cancel is accepted before the queue row is removed", () => {
    const { opened, cancelActionId } = cancelOutstanding();

    emitAck(opened, cancelActionId, "accepted");
    expect(stateOf(opened).heldStop).toBeNull();
    emitQueueChanged(opened.callbacks(), []);

    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);
  });

  it("sends no stop when the matching turn is already terminal, even with the stale raw queue row still present", () => {
    const { opened, sent } = cancelOutstanding();

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: {
        ...turnFor(sent.messageId, "turn-b"),
        status: "completed",
      },
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stopFrames(opened)).toEqual([]);
  });

  it("still stops the send's turn after the confirmed original send's history is legitimately pruned before the queue row is removed", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    emitAck(opened, sent.clientActionId, "accepted");
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    const cancels = framesOfKind(opened, "queueCancel");
    expect(cancels).toHaveLength(1);
    const cancel = cancels[0];
    if (cancel.kind !== "queueCancel") {
      throw new Error("Expected the queueCancel frame");
    }

    // Deliberate bookkeeping simulation: accepted-action history is bounded and
    // prunable. Only the history goes; the linked pending cancel stays.
    expect(stateOf(opened).acceptedActions[sent.clientActionId]).toBeDefined();
    opened.handle.store.setState({ acceptedActions: {} });
    expect(stateOf(opened).acceptedActions).toEqual({});
    expect(stateOf(opened).pendingActions[cancel.clientActionId]?.action).toBe(
      "queueCancel",
    );
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);

    emitQueueChanged(opened.callbacks(), []);
    emitAck(opened, cancel.clientActionId, "rejected");
    startTurn(opened, sent.messageId, "turn-b");

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-b" });
  });

  it("keeps the intent when the transport cannot carry the cancel, and retries once on the fresh reconnect baseline", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    expect(framesOfKind(opened, "queueCancel")).toEqual([]);
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);

    emitSnapshotWithQueue(opened.callbacks(), IDLE_HOST, {
      savedMessageIds: [],
      activeTurn: null,
      queuedMessageIds: [sent.messageId],
    });

    expect(framesOfKind(opened, "queueCancel")).toHaveLength(1);
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);
  });

  it("keeps the intent through a same-epoch empty idle snapshot with a cancel in flight, and a later own activation still stops", () => {
    const { opened, sent } = cancelOutstanding();

    emitSnapshotWithQueue(opened.callbacks(), IDLE_HOST, {
      savedMessageIds: [],
      activeTurn: null,
      queuedMessageIds: [],
    });
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);
    expect(stopFrames(opened)).toEqual([]);

    startTurn(opened, sent.messageId, "turn-b");

    const stops = stopFrames(opened);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-b" });
  });

  it("releases an un-acked intent without a stop once a newer epoch's fresh empty idle baseline arrives", () => {
    const { opened, sent } = cancelOutstanding();

    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);
    emitSnapshotWithQueue(opened.callbacks(), IDLE_HOST, {
      savedMessageIds: [],
      activeTurn: null,
      queuedMessageIds: [],
    });

    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);

    startTurn(opened, sent.messageId, "turn-b");

    expect(stopFrames(opened)).toEqual([]);
  });

  it("does not let the stale ack of a prior cancel attempt clear a newer attempt's intent", () => {
    const { opened, sent, cancelActionId } = cancelOutstanding();
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);
    emitSnapshotWithQueue(opened.callbacks(), IDLE_HOST, {
      savedMessageIds: [],
      activeTurn: null,
      queuedMessageIds: [sent.messageId],
    });
    const cancels = framesOfKind(opened, "queueCancel");
    expect(cancels).toHaveLength(2);
    const newer = cancels[1];
    if (newer.kind !== "queueCancel") {
      throw new Error("Expected the second queueCancel frame");
    }
    expect(newer.clientActionId).not.toBe(cancelActionId);

    emitAck(opened, cancelActionId, "accepted");
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);

    emitAck(opened, newer.clientActionId, "accepted");
    expect(stateOf(opened).heldStop).toBeNull();
    expect(stopFrames(opened)).toEqual([]);
  });

  it("drops the intent on a fatal close", () => {
    const { opened, sent, cancelActionId } = cancelOutstanding();

    opened.callbacks().onConnectionStatus("closed", FATAL, null, null);
    emitAck(opened, cancelActionId, "rejected");
    startTurn(opened, sent.messageId, "turn-b");

    expect(stopFrames(opened)).toEqual([]);
  });
});

describe("a queued send's prompt is drawn at every moment of a drain", () => {
  /** Where the prompt can be seen: the dock, its drain hold, or the transcript. */
  function drawnPlaces(opened: Harness, messageId: string): string[] {
    const state = stateOf(opened);
    const places: string[] = [];
    if (
      state.queue.items.some(
        (item) => item.kind === "prompt" && item.messageId === messageId,
      )
    ) {
      places.push("queue");
    }
    if (
      (state.drainingQueueItems ?? []).some(
        (item) => item.messageId === messageId,
      )
    ) {
      places.push("draining");
    }
    if (state.messages.some((message) => message.messageId === messageId)) {
      places.push("transcript");
    }
    return places;
  }

  function dockedSend(): { opened: Harness; messageId: string } {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    expect(drawnPlaces(opened, sent.messageId)).toEqual(["queue"]);
    return { opened, messageId: sent.messageId };
  }

  it("holds the dock row after the queue item leaves until the transcript row exists (queue frame first)", () => {
    const { opened, messageId } = dockedSend();

    emitQueueChanged(opened.callbacks(), []);
    expect(drawnPlaces(opened, messageId)).toEqual(["draining"]);

    emitMessageAccepted(opened.callbacks(), acceptedMessage(messageId, 10));
    expect(drawnPlaces(opened, messageId)).toEqual(["transcript"]);
  });

  it("never leaves the prompt undrawn when the saved row lands before the queue item leaves", () => {
    const { opened, messageId } = dockedSend();

    emitMessageAccepted(opened.callbacks(), acceptedMessage(messageId, 10));
    expect(drawnPlaces(opened, messageId)).toContain("transcript");

    emitQueueChanged(opened.callbacks(), []);
    expect(drawnPlaces(opened, messageId)).toEqual(["transcript"]);
  });

  it("does not hold a ghost for a row another device cancelled (queue.cancelled event)", () => {
    const { opened, messageId } = dockedSend();

    opened.callbacks().onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        eventId: "event-queue-cancelled",
        type: "queue.cancelled",
        timestamp: 20,
        clientActionId: null,
        actor: null,
        message: null,
        turnId: null,
        messageId,
        queueItemId: `queue-${messageId}`,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: {},
      },
    });
    emitQueueChanged(opened.callbacks(), []);

    expect(drawnPlaces(opened, messageId)).toEqual([]);
  });

  it("does not hold the carried row once the host puts the same prompt back in the queue", () => {
    const { opened, messageId } = dockedSend();
    emitQueueChanged(opened.callbacks(), []);
    expect(drawnPlaces(opened, messageId)).toEqual(["draining"]);

    emitQueueChanged(opened.callbacks(), [queuedPromptItem(messageId)]);

    expect(drawnPlaces(opened, messageId)).toEqual(["queue"]);
  });

  it("does not hold a row the person cancelled out of the dock", () => {
    const { opened, messageId } = dockedSend();
    stateOf(opened).queueCancel(`queue-${messageId}`);

    emitQueueChanged(opened.callbacks(), []);

    expect(drawnPlaces(opened, messageId)).toEqual([]);
  });
});

describe("the working row's timer origin", () => {
  const ENTER = 1_000_000;
  const MINUTES_LATER = ENTER + 5 * 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is Enter for a send that ran at once: no separate origin", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ENTER);
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);

    vi.setSystemTime(MINUTES_LATER);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn?.sentAt).toBe(ENTER);
    expect(stateOf(opened).pendingTurn?.timerOrigin).toBeUndefined();
  });

  it("starts at the drain for a send that waited in the dock, keeping sentAt at Enter", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ENTER);
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    vi.setSystemTime(MINUTES_LATER);
    emitQueueChanged(opened.callbacks(), []);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn?.sentAt).toBe(ENTER);
    expect(stateOf(opened).pendingTurn?.timerOrigin).toBe(MINUTES_LATER);
  });

  it("is also the drain instant for a transcript-placed send the host queued", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ENTER);
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    vi.setSystemTime(MINUTES_LATER);
    emitQueueChanged(opened.callbacks(), []);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn?.timerOrigin).toBe(MINUTES_LATER);
  });

  it("does not move when the saved row lands before the queue item leaves", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ENTER);
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    vi.setSystemTime(MINUTES_LATER);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(sent.messageId, 10),
    );
    const origin = stateOf(opened).pendingTurn?.timerOrigin;
    vi.setSystemTime(MINUTES_LATER + 30_000);
    emitQueueChanged(opened.callbacks(), []);

    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
    expect(stateOf(opened).pendingTurn?.timerOrigin).toBe(origin);
    expect(origin).toBe(MINUTES_LATER);
  });
});

describe("a starting turn's block-less live row", () => {
  function startingTurnFrame(opened: Harness, messageId: string): void {
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });
  }

  it("is removed when a host frame ends the starting turn (activation failed or a Stop withdrew the message)", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    startingTurnFrame(opened, sent.messageId);
    expect(stateOf(opened).liveAssistantMessage).not.toBeNull();

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).liveAssistantMessage).toBeNull();
  });

  it("is kept when the connection drops, since a disconnect is not a host frame", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    startingTurnFrame(opened, sent.messageId);

    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    expect(stateOf(opened).liveAssistantMessage).not.toBeNull();
  });
});

describe("Stop continuity across a queue drain", () => {
  function composerStatus(opened: Harness) {
    const state = stateOf(opened);
    return resolvedTurnStatus(state, composerTurnStatus(state.runStatus));
  }

  it("a dock row with no host turn observed shows no Stop and no latch, until the send's own turn", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    expect(stateOf(opened).queueTurnContinuity).toBeFalsy();
    expect(composerStatus(opened)).toBeNull();

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });
    expect(composerStatus(opened)).toBe("running");
  });

  it("keeps Stop through the gap after an observed turn ends with a runnable backlog, and releases it when the next turn starts", () => {
    const opened = openHarness(IDLE_HOST);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor("message-earlier", "turn-earlier"),
      turnInProgress: true,
      sendWouldQueue: true,
    });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);

    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: true,
    });

    expect(stateOf(opened).queueTurnContinuity).toBe(true);
    expect(composerStatus(opened)).toBe("running");

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-1"),
      turnInProgress: true,
      sendWouldQueue: false,
    });
    emitQueueChanged(opened.callbacks(), []);
    expect(stateOf(opened).queueTurnContinuity).toBeFalsy();
  });

  it("holds the latch while the drained row is carried, and releases it when another device cancelled that row", () => {
    const opened = openHarness(IDLE_HOST);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor("message-earlier", "turn-earlier"),
      turnInProgress: true,
      sendWouldQueue: true,
    });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: true,
    });

    emitQueueChanged(opened.callbacks(), []);
    expect(stateOf(opened).queueTurnContinuity).toBe(true);

    opened.callbacks().onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        eventId: "event-queue-cancelled-2",
        type: "queue.cancelled",
        timestamp: 30,
        clientActionId: null,
        actor: null,
        message: null,
        turnId: null,
        messageId: sent.messageId,
        queueItemId: `queue-${sent.messageId}`,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: {},
      },
    });

    expect(stateOf(opened).queueTurnContinuity).toBeFalsy();
  });
});

describe("an older host's activation with no turn id", () => {
  it("latches the instant this client first saw the turn in progress, and does not move it while the turn continues", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const opened = openHarness(OLDER_HOST_IDLE);
    expect(stateOf(opened).turnObservedAt).toBeUndefined();

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: null,
      turnInProgress: undefined,
      sendWouldQueue: undefined,
    });
    expect(stateOf(opened).turnObservedAt).toBe(2_000_000);

    vi.setSystemTime(2_060_000);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor("message-remote", "turn-remote"),
      turnInProgress: undefined,
      sendWouldQueue: undefined,
    });

    expect(stateOf(opened).turnObservedAt).toBe(2_000_000);
    vi.useRealTimers();
  });
});

describe("rapid sends before any host frame answers the first", () => {
  function expectSecondAndThirdDock(opened: Harness): void {
    const first = sendPrompt(opened);
    const firstTurn = stateOf(opened).pendingTurn;
    expect(firstTurn?.messageId).toBe(first.messageId);

    const second = sendPrompt(opened);
    expect(promptIds(opened)).toEqual([second.messageId]);
    expect(stateOf(opened).pendingUserMessages.map((m) => m.messageId)).toEqual(
      [first.messageId],
    );
    expect(stateOf(opened).pendingTurn).toBe(firstTurn);

    const third = sendPrompt(opened);
    expect(promptIds(opened)).toEqual([second.messageId, third.messageId]);
    expect(stateOf(opened).pendingUserMessages.map((m) => m.messageId)).toEqual(
      [first.messageId],
    );
    expect(stateOf(opened).pendingTurn).toBe(firstTurn);
  }

  it("the first owns the transcript; the second and third dock without replacing its pendingTurn (new host, stale sendWouldQueue:false)", () => {
    expectSecondAndThirdDock(openHarness(IDLE_HOST));
  });

  it("does the same on an older host that publishes no sendWouldQueue", () => {
    expectSecondAndThirdDock(openHarness(OLDER_HOST_IDLE));
  });

  it("a later send owns the transcript again once the first was rejected and the host reads idle", () => {
    const opened = openHarness(IDLE_HOST);
    const first = sendPrompt(opened);
    emitAck(opened, first.clientActionId, "rejected");
    expect(stateOf(opened).pendingTurn).toBeNull();
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });

    const next = sendPrompt(opened);

    expect(promptIds(opened)).toEqual([]);
    expect(stateOf(opened).pendingTurn?.messageId).toBe(next.messageId);
    expect(
      stateOf(opened).pendingUserMessages.map((m) => m.messageId),
    ).toContain(next.messageId);
  });

  it("a later send owns the transcript again once the first settled and a fresh idle frame arrived", () => {
    const opened = openHarness(IDLE_HOST);
    const first = sendPrompt(opened);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(first.messageId, 10),
    );
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });
    expect(stateOf(opened).pendingTurn).toBeNull();

    const next = sendPrompt(opened);

    expect(promptIds(opened)).toEqual([]);
    expect(stateOf(opened).pendingTurn?.messageId).toBe(next.messageId);
  });
});

describe("a setup-failed handback of the send that owns the turn", () => {
  it("clears the pendingTurn, its evidence and a held Stop when the prompt goes back to the composer", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    emitAck(opened, sent.clientActionId, "accepted");
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);

    const restored = stateOf(opened).takeSetupFailedRestoration(sent.messageId);

    expect(restored).not.toBeNull();
    const state = stateOf(opened);
    expect(state.pendingTurn).toBeNull();
    expect(state.pendingTurnEvidence ?? null).toBeNull();
    expect(state.heldStop).toBeNull();
    expect(chatActivityIndicator(state)).toBeNull();
  });

  it("is not undone by the accepted ack that arrives after the handback", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    expect(stateOf(opened).takeSetupFailedRestoration(sent.messageId)).not.toBe(
      null,
    );
    expect(stateOf(opened).pendingTurn).toBeNull();

    emitAck(opened, sent.clientActionId, "accepted");

    expect(stateOf(opened).pendingTurn).toBeNull();
    expect(stateOf(opened).pendingTurnEvidence ?? null).toBeNull();
    expect(chatActivityIndicator(stateOf(opened))).toBeNull();
  });

  it("is not recreated by a later host frame that names the handed-back message's turn", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    emitAck(opened, sent.clientActionId, "accepted");
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-restored"),
      turnInProgress: true,
      sendWouldQueue: false,
    });
    expect(
      stateOf(opened).takeSetupFailedRestoration(sent.messageId),
    ).not.toBeNull();
    expect(stateOf(opened).pendingTurn).toBeNull();

    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-restored"),
      turnInProgress: true,
      sendWouldQueue: false,
    });

    expect(stateOf(opened).pendingTurn).toBeNull();
  });

  it("keeps another send's pendingTurn and held Stop when a different message is handed back", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const other = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(other.messageId)]);
    emitQueueChanged(opened.callbacks(), []);
    emitAck(opened, other.clientActionId, "accepted");
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      sendWouldQueue: false,
    });
    const own = sendPrompt(opened);
    stateOf(opened).stopTurn();
    expect(stateOf(opened).pendingTurn?.messageId).toBe(own.messageId);
    expect(stateOf(opened).heldStop?.messageId).toBe(own.messageId);

    stateOf(opened).takeSetupFailedRestoration(other.messageId);

    expect(stateOf(opened).pendingTurn?.messageId).toBe(own.messageId);
    expect(stateOf(opened).heldStop?.messageId).toBe(own.messageId);
  });
});

describe("a fatal stream close with a send still in custody", () => {
  const FATAL: Parameters<ChatStreamCallbacks["onConnectionStatus"]>[1] = {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "test close",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };

  function statusOf(opened: Harness) {
    return resolvedTurnStatus(
      stateOf(opened),
      composerTurnStatus(stateOf(opened).runStatus),
    );
  }

  it("drops pendingTurn, evidence, held Stop and continuity but keeps the send's recovery records", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();
    expect(stateOf(opened).heldStop).not.toBeNull();
    expect(statusOf(opened)).toBe("stopping");

    opened.callbacks().onConnectionStatus("closed", FATAL, null, null);

    const state = stateOf(opened);
    expect(state.fatalClose).not.toBeNull();
    expect(state.pendingTurn).toBeNull();
    expect(state.pendingTurnEvidence ?? null).toBeNull();
    expect(state.heldStop).toBeNull();
    expect(state.queueTurnContinuity ?? false).toBe(false);
    expect(Object.values(state.pendingActions).map((a) => a.messageId)).toEqual(
      [sent.messageId],
    );
    expect(state.pendingUserMessages.map((m) => m.messageId)).toEqual([
      sent.messageId,
    ]);
    expect(statusOf(opened)).toBeNull();
  });

  it("shows no Stop after a fatal close for an un-held send either", () => {
    const opened = openHarness(IDLE_HOST);
    sendPrompt(opened);
    expect(statusOf(opened)).toBe("running");

    opened.callbacks().onConnectionStatus("closed", FATAL, null, null);

    expect(statusOf(opened)).toBeNull();
  });

  it("a non-fatal reconnect keeps the pendingTurn, held Stop and their presentation", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    stateOf(opened).stopTurn();

    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    expect(stateOf(opened).fatalClose).toBeNull();
    expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);
    expect(stateOf(opened).heldStop?.messageId).toBe(sent.messageId);
    expect(statusOf(opened)).toBe("stopping");
  });

  it("a non-fatal reconnect with no held Stop still reads running", () => {
    const opened = openHarness(IDLE_HOST);
    sendPrompt(opened);

    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    expect(stateOf(opened).pendingTurn).not.toBeNull();
    expect(statusOf(opened)).toBe("running");
  });

  function carriedSend(): { opened: Harness; messageId: string } {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    emitQueueChanged(opened.callbacks(), []);
    expect(
      stateOf(opened).drainingQueueItems?.map((item) => item.messageId),
    ).toEqual([sent.messageId]);
    return { opened, messageId: sent.messageId };
  }

  it("a fatal close clears the activity of a carried prompt while the carry stays as custody", () => {
    const { opened, messageId } = carriedSend();
    expect(chatActivityIndicator(stateOf(opened))).toBe("turn");

    opened.callbacks().onConnectionStatus("closed", FATAL, null, null);

    const state = stateOf(opened);
    expect(state.fatalClose).not.toBeNull();
    expect(state.pendingTurn).toBeNull();
    expect(state.heldStop).toBeNull();
    expect(state.queueTurnContinuity ?? false).toBe(false);
    expect(state.drainingQueueItems?.map((item) => item.messageId)).toEqual([
      messageId,
    ]);
    expect(chatActivityIndicator(state)).toBeNull();
  });

  it("a non-fatal reconnect keeps a carried prompt busy", () => {
    const { opened } = carriedSend();

    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);

    expect(stateOf(opened).fatalClose).toBeNull();
    expect(stateOf(opened).drainingQueueItems).toHaveLength(1);
    expect(chatActivityIndicator(stateOf(opened))).toBe("turn");
  });
});

describe("sends buffered across a reconnect, before the first host frame places them", () => {
  it("admits the first buffered prompt on an idle baseline and queues the second", () => {
    const opened = openHarness(IDLE_HOST);
    opened.callbacks().onConnectionStatus("reconnecting", null, null, null);
    opened.callbacks().onConnectionStatus("open", null, null, null);
    const first = sendPrompt(opened);
    const second = sendPrompt(opened);
    expect(stateOf(opened).unplacedSendIds?.size ?? 0).toBeGreaterThan(0);

    emitSnapshot(opened.callbacks(), IDLE_HOST);

    expect(stateOf(opened).pendingUserMessages.map((m) => m.messageId)).toEqual(
      [first.messageId],
    );
    expect(promptIds(opened)).toEqual([second.messageId]);
    expect(stateOf(opened).pendingTurn?.messageId).toBe(first.messageId);
  });
});

describe("a host frame that retains our own terminal activeTurn metadata", () => {
  const TERMINAL = ["completed", "stopped", "interrupted", "errored"] as const;

  function terminalTurn(
    messageId: string,
    status: (typeof TERMINAL)[number],
  ): ChatActiveTurn {
    return { ...turnFor(messageId, "turn-terminal"), status };
  }

  function emitTerminal(
    opened: Harness,
    messageId: string,
    status: (typeof TERMINAL)[number],
  ): void {
    emitTurnState(opened.callbacks(), {
      runStatus: "idle",
      activeTurn: terminalTurn(messageId, status),
      turnInProgress: false,
      sendWouldQueue: false,
    });
  }

  it.each(TERMINAL)(
    "ends the pendingTurn of a seen turn that reads %s, with no queue",
    (status) => {
      const opened = openHarness(IDLE_HOST);
      const sent = sendPrompt(opened);
      emitTurnState(opened.callbacks(), {
        runStatus: "running",
        activeTurn: turnFor(sent.messageId, "turn-terminal"),
        turnInProgress: true,
        sendWouldQueue: false,
      });
      expect(stateOf(opened).pendingTurn?.messageId).toBe(sent.messageId);

      emitTerminal(opened, sent.messageId, status);

      expect(stateOf(opened).pendingTurn).toBeNull();
      expect(
        resolvedTurnStatus(
          stateOf(opened),
          composerTurnStatus(stateOf(opened).runStatus),
        ),
      ).toBeNull();
    },
  );

  it.each(TERMINAL)(
    "drops a Stop held before the first observed frame, which already reads %s, and dispatches nothing",
    (status) => {
      const opened = openHarness(IDLE_HOST);
      const sent = sendPrompt(opened);
      stateOf(opened).stopTurn();
      expect(stateOf(opened).heldStop).not.toBeNull();

      emitTerminal(opened, sent.messageId, status);

      expect(stateOf(opened).heldStop).toBeNull();
      expect(stateOf(opened).pendingTurn).toBeNull();
      expect(framesOfKind(opened, "stop")).toEqual([]);
      expect(framesOfKind(opened, "queueCancel")).toEqual([]);
    },
  );

  it("does not recreate the pendingTurn when the send's accepted ack lands after the terminal frame", () => {
    const opened = openHarness(IDLE_HOST);
    const sent = sendPrompt(opened);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: turnFor(sent.messageId, "turn-terminal"),
      turnInProgress: true,
      sendWouldQueue: false,
    });
    emitTerminal(opened, sent.messageId, "completed");
    expect(stateOf(opened).pendingTurn).toBeNull();

    emitAck(opened, sent.clientActionId, "accepted");

    expect(stateOf(opened).pendingTurn).toBeNull();
    expect(stateOf(opened).heldStop).toBeNull();
    expect(
      resolvedTurnStatus(
        stateOf(opened),
        composerTurnStatus(stateOf(opened).runStatus),
      ),
    ).toBeNull();

    const next = sendPrompt(opened);

    expect(promptIds(opened)).toEqual([]);
    expect(stateOf(opened).pendingTurn?.messageId).toBe(next.messageId);
  });
});

describe("the drain carry keeps its identity across unrelated updates", () => {
  function unrelatedEvent(opened: Harness, eventId: string): void {
    opened.callbacks().onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        eventId,
        type: "turn.started",
        timestamp: 30,
        clientActionId: null,
        actor: null,
        message: null,
        turnId: "turn-unrelated",
        messageId: null,
        queueItemId: null,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: {},
      },
    });
  }

  it("keeps the same nonempty array and item objects while the carried prompt is still owed", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const sent = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [queuedPromptItem(sent.messageId)]);
    emitQueueChanged(opened.callbacks(), []);
    const carried = stateOf(opened).drainingQueueItems;
    expect(carried?.map((item) => item.messageId)).toEqual([sent.messageId]);

    unrelatedEvent(opened, "event-unrelated-1");
    unrelatedEvent(opened, "event-unrelated-2");

    expect(stateOf(opened).drainingQueueItems).toBe(carried);
    expect(stateOf(opened).drainingQueueItems?.[0]).toBe(carried?.[0]);
  });

  it("keeps the same empty array when nothing is carried", () => {
    const opened = openHarness(IDLE_HOST);
    unrelatedEvent(opened, "event-unrelated-1");
    const empty = stateOf(opened).drainingQueueItems;
    expect(empty ?? []).toEqual([]);

    unrelatedEvent(opened, "event-unrelated-2");
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage("other-message", 10),
    );

    expect(stateOf(opened).drainingQueueItems).toBe(empty);
  });
});

describe("no frame order draws one prompt in the transcript and the dock at once", () => {
  type Step = "ack" | "add" | "remove" | "accepted" | "snap";

  function permutations<T>(items: ReadonlyArray<T>): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
        (rest) => [item, ...rest],
      ),
    );
  }

  function dockedIds(opened: Harness): Set<string> {
    const state = stateOf(opened);
    return new Set([
      ...state.queue.items.flatMap((item) =>
        item.kind === "prompt" ? [item.messageId] : [],
      ),
      ...(state.drainingQueueItems ?? []).map((item) => item.messageId),
    ]);
  }

  interface Observed {
    carried: boolean;
    pendingCopy: boolean;
    docked: boolean;
  }

  /**
   * Custody action records survive a queue add on purpose; the invariant is
   * about what is DRAWN: a pending transcript copy against the queue or its
   * carry, and a saved row against the carry.
   */
  function expectNoDoubleDrawn(
    opened: Harness,
    when: string,
    observed: Observed,
  ): void {
    const state = stateOf(opened);
    if ((state.drainingQueueItems ?? []).length > 0) observed.carried = true;
    if (state.pendingUserMessages.length > 0) observed.pendingCopy = true;
    if (state.queue.items.length > 0) observed.docked = true;
    const docked = dockedIds(opened);
    const carried = new Set(
      (state.drainingQueueItems ?? []).map((item) => item.messageId),
    );
    for (const pending of state.pendingUserMessages) {
      expect(
        docked.has(pending.messageId),
        `${when}: ${pending.messageId} is a pending transcript copy and docked`,
      ).toBe(false);
    }
    for (const message of state.messages) {
      expect(
        carried.has(message.messageId),
        `${when}: ${message.messageId} is saved and still carried`,
      ).toBe(false);
    }
  }

  function play(
    host: HostFacts,
    steps: ReadonlyArray<Step>,
    observed: Observed,
  ): void {
    harness?.handle.dispose();
    const opened = openHarness(host);
    const sent = sendPrompt(opened);
    const label = steps.join(" > ");
    expectNoDoubleDrawn(opened, `${label} @send`, observed);
    let queued = false;
    let saved = false;
    for (const step of steps) {
      if (step === "ack") {
        emitAck(opened, sent.clientActionId, "accepted");
      } else if (step === "add") {
        queued = true;
        emitQueueChanged(opened.callbacks(), [
          queuedPromptItem(sent.messageId),
        ]);
      } else if (step === "remove") {
        queued = false;
        emitQueueChanged(opened.callbacks(), []);
      } else if (step === "accepted") {
        saved = true;
        emitMessageAccepted(
          opened.callbacks(),
          acceptedMessage(sent.messageId, 10),
        );
      } else {
        opened.callbacks().onConnectionStatus("reconnecting", null, null, null);
        emitSnapshotWithQueue(opened.callbacks(), host, {
          savedMessageIds: saved ? [sent.messageId] : [],
          activeTurn: null,
          queuedMessageIds: queued ? [sent.messageId] : [],
        });
      }
      expectNoDoubleDrawn(opened, `${label} @${step}`, observed);
    }
  }

  function freshObserved(): Observed {
    return { carried: false, pendingCopy: false, docked: false };
  }

  const HOSTS: ReadonlyArray<readonly [string, HostFacts]> = [
    ["idle new host", IDLE_HOST],
    ["new host that queues", { ...IDLE_HOST, sendWouldQueue: true }],
    ["older host", OLDER_HOST_IDLE],
  ];

  const QUEUED_ORDERS = permutations<Step>([
    "ack",
    "add",
    "remove",
    "accepted",
    "snap",
  ]).filter(
    (order) =>
      order.indexOf("add") < order.indexOf("remove") &&
      order.indexOf("add") < order.indexOf("accepted"),
  );
  const DIRECT_ORDERS = permutations<Step>(["ack", "accepted", "snap"]);

  it.each(HOSTS)(
    "a queued send, every order of ack, queue add, queue removal, saved row and a reconnect snapshot (%s)",
    (_name, host) => {
      expect(QUEUED_ORDERS).toHaveLength(40);
      const observed = freshObserved();
      for (const order of QUEUED_ORDERS) play(host, order, observed);
      afterEachHarness();
    },
  );

  it.each(HOSTS)(
    "a send the host never queues, every order of ack, saved row and a reconnect snapshot (%s)",
    (_name, host) => {
      expect(DIRECT_ORDERS).toHaveLength(6);
      const observed = freshObserved();
      for (const order of DIRECT_ORDERS) play(host, order, observed);
      afterEachHarness();
    },
  );

  function afterEachHarness(): void {
    harness?.handle.dispose();
    harness = null;
  }

  it("the queued orders did reach a carried dock row, a pending transcript copy and a queued row", () => {
    const observed = freshObserved();
    for (const order of QUEUED_ORDERS) {
      play({ ...IDLE_HOST, sendWouldQueue: true }, order, observed);
      play(IDLE_HOST, order, observed);
    }
    expect(observed).toEqual({
      carried: true,
      pendingCopy: true,
      docked: true,
    });
  });

  it("two sends with equal text and distinct ids keep their own custody through a drain", () => {
    const pairObserved = freshObserved();
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const first = sendPrompt(opened);
    const second = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [
      queuedPromptItem(first.messageId),
      queuedPromptItem(second.messageId),
    ]);
    expectNoDoubleDrawn(opened, "both queued", pairObserved);

    emitQueueChanged(opened.callbacks(), [queuedPromptItem(second.messageId)]);
    expectNoDoubleDrawn(opened, "first drained", pairObserved);
    expect(dockedIds(opened)).toEqual(
      new Set([first.messageId, second.messageId]),
    );

    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(first.messageId, 10),
    );
    expectNoDoubleDrawn(opened, "first saved", pairObserved);
    expect(dockedIds(opened)).toEqual(new Set([second.messageId]));

    emitQueueChanged(opened.callbacks(), []);
    expectNoDoubleDrawn(opened, "second drained", pairObserved);
    emitMessageAccepted(
      opened.callbacks(),
      acceptedMessage(second.messageId, 11),
    );
    expectNoDoubleDrawn(opened, "second saved", pairObserved);
    expect(dockedIds(opened).size).toBe(0);
  });
});

describe("the host turn clock on a host that publishes turnInProgress but no sendWouldQueue (1.33)", () => {
  const T1 = 2_000_000;
  const T2 = 2_600_000;
  const T3 = 3_200_000;

  function runningTurn(userMessageId: string | null, turnId: string) {
    return { ...turnFor(userMessageId, turnId), status: "running" as const };
  }

  function hostFrame(opened: Harness, activeTurn: ChatActiveTurn | null): void {
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
      sendWouldQueue: undefined,
    });
  }

  function clockOf(opened: Harness): number {
    const state = stateOf(opened);
    return resolveTurnPresentation({
      chatId: CHAT_ID,
      pendingTurn: state.pendingTurn ?? null,
      activeTurn: state.activeTurn,
      observedAt: state.turnObservedAt ?? -1,
      localMessageCreatedAt: null,
      hostAnchorAt: null,
    }).elapsedStartedAt;
  }

  function openAtTurnA(): Harness {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T1);
    const opened = openHarness({
      runStatus: "idle",
      turnInProgress: false,
      sendWouldQueue: undefined,
    });
    hostFrame(opened, runningTurn("message-a", "turn-a"));
    expect(stateOf(opened).turnObservedAt).toBe(T1);
    return opened;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts the clock when a queued prompt's activation gap (turnInProgress, no activeTurn) follows turn A", () => {
    const opened = openAtTurnA();

    vi.setSystemTime(T2);
    hostFrame(opened, null);

    expect(stateOf(opened).turnObservedAt).toBe(T2);
    expect(clockOf(opened)).toBe(T2);
  });

  it("restarts the observation when turn B replaces turn A without a gap", () => {
    const opened = openAtTurnA();

    vi.setSystemTime(T2);
    hostFrame(opened, runningTurn("message-b", "turn-b"));

    expect(stateOf(opened).turnObservedAt).toBe(T2);
  });

  it("does not restart on a repeated frame of the same turn A", () => {
    const opened = openAtTurnA();

    vi.setSystemTime(T2);
    hostFrame(opened, runningTurn("message-a", "turn-a"));
    vi.setSystemTime(T3);
    hostFrame(opened, runningTurn("message-a", "turn-a"));

    expect(stateOf(opened).turnObservedAt).toBe(T1);
  });

  it("keeps the send's own timer origin (Enter) across the host's handoff frames", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T1);
    const opened = openHarness(OLDER_HOST_IDLE);
    const sent = sendPrompt(opened);
    const enter = stateOf(opened).pendingTurn?.sentAt;
    expect(enter).toBe(T1);
    expect(clockOf(opened)).toBe(T1);

    vi.setSystemTime(T2);
    emitTurnState(opened.callbacks(), {
      runStatus: "running",
      activeTurn: null,
      turnInProgress: true,
      sendWouldQueue: undefined,
    });
    expect(clockOf(opened)).toBe(T1);

    vi.setSystemTime(T3);
    hostFrame(opened, runningTurn(sent.messageId, "turn-own"));
    expect(clockOf(opened)).toBe(T1);
  });
});

describe("the dock keeps queue order while the front prompt is carried", () => {
  function displayedIds(opened: Harness): string[] {
    return queueWithDrainingPrompts(stateOf(opened)).items.flatMap((item) =>
      item.kind === "prompt" ? [item.messageId] : [],
    );
  }

  it("shows the activated front prompt A ahead of the remaining queue [B]", () => {
    const opened = openHarness({ ...IDLE_HOST, sendWouldQueue: true });
    const a = sendPrompt(opened);
    const b = sendPrompt(opened);
    emitQueueChanged(opened.callbacks(), [
      queuedPromptItem(a.messageId),
      queuedPromptItem(b.messageId),
    ]);
    expect(displayedIds(opened)).toEqual([a.messageId, b.messageId]);

    emitQueueChanged(opened.callbacks(), [queuedPromptItem(b.messageId)]);

    expect(promptIds(opened)).toEqual([b.messageId]);
    expect(stateOf(opened).drainingQueueItems?.map((i) => i.messageId)).toEqual(
      [a.messageId],
    );
    expect(displayedIds(opened)).toEqual([a.messageId, b.messageId]);
  });
});

describe("the activity indicator from Enter, through the real store", () => {
  it("reads turn the moment a send owns its turn, with the host still idle, and null before", () => {
    const opened = openHarness(IDLE_HOST);
    expect(chatActivityIndicator(stateOf(opened))).toBeNull();

    sendPrompt(opened);

    expect(stateOf(opened).runStatus).toBe("idle");
    expect(chatActivityIndicator(stateOf(opened))).toBe("turn");
  });

  it("keeps turn while a Stop is held on an idle host", () => {
    const opened = openHarness(IDLE_HOST);
    sendPrompt(opened);
    stateOf(opened).stopTurn();

    expect(stateOf(opened).heldStop).not.toBeNull();
    expect(chatActivityIndicator(stateOf(opened))).toBe("turn");
  });
});

describe("a session stop while a local send is pending behind another host turn", () => {
  const GATED_COMMAND = {
    taskId: "task-gated",
    kind: "command" as const,
    title: "codex exec",
    blockId: "tool-1",
    parentTaskId: null,
    scheduledFor: null,
    individualStopUnavailable: {
      providerLabel: "Codex",
      minVersion: "0.146.0",
    },
  };

  function turnA(): ChatActiveTurn {
    return {
      ...turnFor("message-a", "turn-a"),
      status: "running",
    };
  }

  function hostTurnWithBackground(
    opened: Harness,
    activeTurn: ChatActiveTurn | null,
  ): void {
    opened.callbacks().onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: activeTurn === null ? "idle" : "running",
      activeTurn,
      turnInProgress: activeTurn !== null,
      sendWouldQueue: false,
      backgroundItems: [GATED_COMMAND],
    });
  }

  function pendingBehindTurnA(): { opened: Harness; localMessageId: string } {
    const opened = openHarness(IDLE_HOST);
    const local = sendPrompt(opened);
    hostTurnWithBackground(opened, turnA());
    expect(stateOf(opened).pendingTurn?.messageId).toBe(local.messageId);
    expect(stateOf(opened).activeTurn?.userMessageId).toBe("message-a");
    return { opened, localMessageId: local.messageId };
  }

  it("stops the current host turn directly, holds nothing for the pending send, and waits for the turn to end before the session stop", () => {
    const { opened } = pendingBehindTurnA();

    const sent = stateOf(opened).stopBackgroundSession();

    expect(sent).not.toBeNull();
    const stops = framesOfKind(opened, "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "stop", turnId: "turn-a" });
    expect(stateOf(opened).heldStop).toBeNull();
    expect(stateOf(opened).pendingBackgroundSessionStop).toMatchObject({
      awaitingTurnEnd: true,
      turnId: "turn-a",
    });
    expect(framesOfKind(opened, "stopBackgroundSession")).toEqual([]);

    hostTurnWithBackground(opened, null);

    expect(framesOfKind(opened, "stopBackgroundSession")).toHaveLength(1);
  });

  it("the generic Stop in the same state still holds for the pending send and never names turn A", () => {
    const { opened, localMessageId } = pendingBehindTurnA();

    stateOf(opened).stopTurn();

    expect(framesOfKind(opened, "stop")).toEqual([]);
    expect(stateOf(opened).heldStop?.messageId).toBe(localMessageId);
  });
});
