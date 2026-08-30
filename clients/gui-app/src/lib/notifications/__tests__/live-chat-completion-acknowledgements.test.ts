import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLiveChatCompletionAcknowledgementTransport,
  liveChatCompletionAcknowledgementMatches,
} from "@/lib/notifications/live-chat-completion-acknowledgements";
import { createChatSessionStoreWithNotificationDependencies } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { createAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

  private readonly listeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (peers === undefined) return;
    for (const peer of peers) {
      if (peer === this) continue;
      const event = new MessageEvent("message", { data });
      for (const listener of peer.listeners) listener(event);
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }
}

describe("live chat completion acknowledgements", () => {
  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeBroadcastChannel.reset();
    window.localStorage.clear();
  });

  it("reconciles a failed renderer after activeTurn is cleared", () => {
    vi.useFakeTimers();
    const rendererA = createChatRenderer("renderer-a");
    const rendererB = createChatRenderer("renderer-b");
    rendererA.notifications.getState().activateIdentity("user-1");
    rendererB.notifications.getState().activateIdentity("user-1");
    startTurn(rendererA.callbacks(), "turn-1");
    startTurn(rendererB.callbacks(), "turn-1");

    vi.setSystemTime(10);
    rendererB.callbacks().onConnectionStatus("closed", fatalCloseReason());
    expect(rendererB.handle.store.getState().activeTurn).toBeNull();
    expect(
      rendererB.notifications.getState().byId[FAILURE_ID].readAt,
    ).toBeNull();

    vi.setSystemTime(20);
    completeTurn(rendererA.callbacks(), "turn-1");
    expect(rendererB.notifications.getState().byId[FAILURE_ID].readAt).toBe(20);

    rendererB.handle.store.getState().retry();
    startTurn(rendererB.callbacks(), "turn-1");
    vi.setSystemTime(30);
    rendererB.callbacks().onConnectionStatus("closed", fatalCloseReason());
    expect(
      rendererB.notifications.getState().byId[FAILURE_ID].readAt,
    ).toBeNull();

    rendererA.handle.store.getState().dispose();
    rendererB.handle.store.getState().dispose();
    rendererA.transport.dispose();
    rendererB.transport.dispose();
  });

  it("keeps different turns and failures newer than the completion unread", () => {
    const rendererA =
      createLiveChatCompletionAcknowledgementTransport("renderer-a");
    const rendererB =
      createLiveChatCompletionAcknowledgementTransport("renderer-b");
    const storeB = createAppLocalNotificationsStore("renderer-b-store");
    storeB.getState().activateIdentity("user-1");
    storeB.getState().upsert(streamFailure(30));
    const unsubscribeB = rendererB.subscribe((acknowledgement) => {
      if (
        !liveChatCompletionAcknowledgementMatches(acknowledgement, {
          userId: "user-1",
          originHostId: "host-1",
          epicId: "epic-1",
          chatId: "chat-1",
          recoverableTurnId: "turn-2",
        })
      ) {
        return;
      }
      storeB
        .getState()
        .markEntityAsReadBefore(
          "host-1",
          { epicId: "epic-1", chatId: "chat-1" },
          40,
          acknowledgement.observedAt,
        );
    });

    rendererA.publish({
      userId: "user-1",
      originHostId: "host-1",
      epicId: "epic-1",
      chatId: "chat-1",
      turnId: "turn-1",
      observedAt: 20,
    });
    expect(storeB.getState().byId.failure.readAt).toBeNull();

    rendererA.publish({
      userId: "user-1",
      originHostId: "host-1",
      epicId: "epic-1",
      chatId: "chat-1",
      turnId: "turn-2",
      observedAt: 20,
    });
    expect(storeB.getState().byId.failure.readAt).toBeNull();

    unsubscribeB();
    rendererA.dispose();
    rendererB.dispose();
  });
});

function streamFailure(updatedAt: number) {
  return {
    id: "failure",
    originHostId: "host-1",
    updatedAt,
    readAt: null,
    kind: "stream.transport.error" as const,
    sourceRef: "chat-1",
    payload: { kind: "chat" as const, epicId: "epic-1", chatId: "chat-1" },
    message: "Agent stream closed unexpectedly.",
    detail: "Connection lost",
  };
}

const FAILURE_ID = "stream.transport.error:host-1:chat-1:CONNECTION_LOST";

function createChatRenderer(originId: string) {
  const transport = createLiveChatCompletionAcknowledgementTransport(originId);
  const notifications = createAppLocalNotificationsStore(`${originId}-store`);
  const callbackHistory: ChatStreamCallbacks[] = [];
  const handle = createChatSessionStoreWithNotificationDependencies(
    {
      hostId: "host-1",
      epicId: "epic-1",
      chatId: "chat-1",
      userId: "user-1",
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, callbacks) => {
        callbackHistory.push(callbacks);
        return {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        };
      },
    },
    {
      completionAcknowledgements: transport,
      appLocalNotifications: notifications,
    },
  );
  return {
    transport,
    notifications,
    handle,
    callbacks: (): ChatStreamCallbacks => {
      const callbacks = callbackHistory.at(-1);
      if (callbacks === undefined) throw new Error("Expected chat callbacks");
      return callbacks;
    },
  };
}

function startTurn(callbacks: ChatStreamCallbacks, turnId: string): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    runStatus: "running",
    activeTurn: {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId,
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 1,
      updatedAt: 1,
      reasoningEffort: null,
      serviceTier: null,
    },
  });
}

function completeTurn(callbacks: ChatStreamCallbacks, turnId: string): void {
  callbacks.onBlockDelta({
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event: {
      type: "turn.completed",
      blockId: turnId,
      timestamp: Date.now(),
      turnId,
    },
  });
}

function fatalCloseReason() {
  return {
    kind: "fatalError" as const,
    details: {
      code: "CONNECTION_LOST",
      reason: "Connection lost",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}
