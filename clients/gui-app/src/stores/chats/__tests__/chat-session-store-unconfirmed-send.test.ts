import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  unconfirmedSendActionIdsOf,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS } from "@/stores/chats/queue-edit-custody";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * A send the host has not answered for the display deadline stops CLAIMING it
 * is on its way - and only that. Nothing is rejected, nothing is retransmitted,
 * and the pending action keeps every id and byte it was dispatched with.
 */

const EPIC_ID = "epic-unconfirmed";
const CHAT_ID = "chat-unconfirmed";
const OWNER_ID = "owner-unconfirmed";
const HOST_ID = "host-a";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const CONTENT = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "hello host" }] },
  ],
};

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  readonly resnapshots: number[];
  readonly factoryCalls: number[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  const resnapshots: number[] = [];
  const factoryCalls: number[] = [];
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
      factoryCalls.push(factoryCalls.length);
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => {
          resnapshots.push(resnapshots.length);
        },
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    resnapshots,
    factoryCalls,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function emitSnapshot(harness: Harness): void {
  harness.callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: HOST_ID,
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
    },
  });
}

function openHarness(): Harness {
  const next = createHarness();
  next.callbacks().onConnectionStatus("open", null, null);
  emitSnapshot(next);
  return next;
}

interface DispatchedSend {
  readonly clientActionId: string;
  readonly messageId: string;
}

function dispatchSend(harness: Harness): DispatchedSend {
  harness.handle.store.getState().sendMessage({
    content: CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: [],
    deliveryPolicy: "auto",
    restore: { content: CONTENT, browserAnnotations: [] },
  });
  const frame = harness.sent.at(-1);
  if (frame?.kind !== "send") throw new Error("expected a send frame");
  return { clientActionId: frame.clientActionId, messageId: frame.messageId };
}

function ackSend(
  harness: Harness,
  send: DispatchedSend,
  status: "accepted" | "rejected",
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: send.clientActionId,
    action: "send",
    status,
    reason: status === "rejected" ? "refused" : null,
    code: status === "rejected" ? "SEND_REFUSED" : null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function sendFrames(harness: Harness): ChatSubscribeClientFrame[] {
  return harness.sent.filter((frame) => frame.kind === "send");
}

let harness: Harness | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
  vi.useRealTimers();
});

describe("a send unanswered at the display deadline", () => {
  it("is named unconfirmed while its pending action, content and frame count stay exactly as dispatched", () => {
    harness = openHarness();
    const send = dispatchSend(harness);
    const pendingBefore =
      harness.handle.store.getState().pendingActions[send.clientActionId];
    expect(pendingBefore.action).toBe("send");
    expect(
      unconfirmedSendActionIdsOf(harness.handle.store.getState()).has(
        send.clientActionId,
      ),
    ).toBe(false);

    vi.advanceTimersByTime(UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS);

    const state = harness.handle.store.getState();
    expect(unconfirmedSendActionIdsOf(state).has(send.clientActionId)).toBe(
      true,
    );
    const pendingAfter = state.pendingActions[send.clientActionId];
    expect(pendingAfter).toBe(pendingBefore);
    expect(pendingAfter.action).toBe("send");
    expect(pendingAfter.messageId).toBe(send.messageId);
    expect(pendingAfter.wireContent).toEqual(CONTENT);
    expect(state.failedSendRestoration).toBeNull();
    // ONE send frame, ever: nothing retransmitted.
    expect(sendFrames(harness)).toHaveLength(1);
  });

  it("leaves the set, with no rejection notice and no second frame, when the accepted ack arrives late", () => {
    harness = openHarness();
    const send = dispatchSend(harness);
    vi.advanceTimersByTime(UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS);
    expect(
      unconfirmedSendActionIdsOf(harness.handle.store.getState()).has(
        send.clientActionId,
      ),
    ).toBe(true);

    ackSend(harness, send, "accepted");

    const state = harness.handle.store.getState();
    expect(unconfirmedSendActionIdsOf(state).has(send.clientActionId)).toBe(
      false,
    );
    expect(state.errorNotices).toEqual([]);
    expect(state.failedSendRestoration).toBeNull();
    expect(sendFrames(harness)).toHaveLength(1);
  });

  it("never enters the set for a send acked before the deadline", () => {
    harness = openHarness();
    const send = dispatchSend(harness);
    vi.advanceTimersByTime(UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS - 1);
    ackSend(harness, send, "accepted");

    vi.advanceTimersByTime(UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS);

    const state = harness.handle.store.getState();
    expect(state.unconfirmedSendActionIds.has(send.clientActionId)).toBe(false);
    expect(unconfirmedSendActionIdsOf(state).has(send.clientActionId)).toBe(
      false,
    );
  });

  it("does not mark a send whose connection dropped before the deadline", () => {
    harness = openHarness();
    const send = dispatchSend(harness);
    const epochAtSend = harness.handle.store.getState().connectionEpoch;
    harness.callbacks().onConnectionStatus("closed", null, null);
    harness.callbacks().onConnectionStatus("open", null, null);
    // The epoch really moved, so the timer's guard is what is being tested.
    expect(harness.handle.store.getState().connectionEpoch).toBeGreaterThan(
      epochAtSend,
    );
    expect(
      harness.handle.store.getState().pendingActions[send.clientActionId],
    ).toBeDefined();

    vi.advanceTimersByTime(UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS);

    expect(
      harness.handle.store
        .getState()
        .unconfirmedSendActionIds.has(send.clientActionId),
    ).toBe(false);
  });
});

describe("checkSendDelivery", () => {
  it("asks the host again without dispatching a send, leaving the pending send untouched", () => {
    harness = openHarness();
    const send = dispatchSend(harness);
    vi.advanceTimersByTime(UNCONFIRMED_SEND_DISPLAY_DEADLINE_MS);
    const pendingBefore =
      harness.handle.store.getState().pendingActions[send.clientActionId];
    const askedBefore =
      harness.resnapshots.length + harness.factoryCalls.length;

    harness.handle.store.getState().checkSendDelivery();

    // It DID something: a resnapshot request or a re-subscribe.
    expect(
      harness.resnapshots.length + harness.factoryCalls.length,
    ).toBeGreaterThan(askedBefore);
    expect(sendFrames(harness)).toHaveLength(1);
    const state = harness.handle.store.getState();
    expect(state.pendingActions[send.clientActionId]).toBe(pendingBefore);
    expect(pendingBefore.messageId).toBe(send.messageId);
  });
});
