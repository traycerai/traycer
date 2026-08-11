import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLiveChatCompletionAcknowledgementTransport,
  liveChatCompletionAcknowledgementMatches,
} from "@/lib/notifications/live-chat-completion-acknowledgements";
import { createAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

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
    vi.unstubAllGlobals();
    FakeBroadcastChannel.reset();
    window.localStorage.clear();
  });

  it("reconciles an earlier failure in an independent renderer store", () => {
    const rendererA =
      createLiveChatCompletionAcknowledgementTransport("renderer-a");
    const rendererB =
      createLiveChatCompletionAcknowledgementTransport("renderer-b");
    const storeA = createAppLocalNotificationsStore("renderer-a-store");
    const storeB = createAppLocalNotificationsStore("renderer-b-store");
    storeA.getState().activateIdentity("user-1");
    storeB.getState().activateIdentity("user-1");
    storeA.getState().upsert(streamFailure(10));
    storeB.getState().upsert(streamFailure(10));

    const unsubscribeB = rendererB.subscribe((acknowledgement) => {
      if (
        !liveChatCompletionAcknowledgementMatches(acknowledgement, {
          userId: "user-1",
          originHostId: "host-1",
          epicId: "epic-1",
          chatId: "chat-1",
          activeTurnId: "turn-1",
        })
      ) {
        return;
      }
      storeB
        .getState()
        .markEntityAsReadBefore(
          "host-1",
          { epicId: "epic-1", chatId: "chat-1" },
          21,
          acknowledgement.observedAt,
        );
    });

    storeA
      .getState()
      .markEntityAsRead("host-1", { epicId: "epic-1", chatId: "chat-1" }, 20);
    rendererA.publish({
      userId: "user-1",
      originHostId: "host-1",
      epicId: "epic-1",
      chatId: "chat-1",
      turnId: "turn-1",
      observedAt: 20,
    });

    expect(storeA.getState().byId.failure.readAt).toBe(20);
    expect(storeB.getState().byId.failure.readAt).toBe(21);

    unsubscribeB();
    rendererA.dispose();
    rendererB.dispose();
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
          activeTurnId: "turn-2",
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
