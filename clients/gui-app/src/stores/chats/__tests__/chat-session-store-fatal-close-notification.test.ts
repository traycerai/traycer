/**
 * An adjudicated fatal close of a chat stream raises the app's "Agent stream
 * closed unexpectedly" notification, unless the session's opener said its
 * surface tells the failure itself (`fatalCloseNotification: "silent"`, a
 * bot's channel and threads). Driven through the stream callbacks a host
 * would call, into a real app-local notifications store.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { createLiveChatCompletionAcknowledgementTransport } from "@/lib/notifications/live-chat-completion-acknowledgements";
import {
  createChatSessionStoreWithNotificationDependencies,
  type ChatSessionStoreOptions,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { createAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  forgetEndedSandboxHost,
  recordEndedSandboxHost,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

const failureId = (hostId: string): string =>
  `stream.transport.error:${hostId}:chat-1:CONNECTION_LOST`;

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  forgetEndedSandboxHost("host-1");
  // The notifications store persists under its name; the next case starts bare.
  window.localStorage.clear();
});

function buildSession(
  hostId: string,
  notificationOption: Pick<ChatSessionStoreOptions, "fatalCloseNotification">,
): {
  readonly callbacks: () => ChatStreamCallbacks;
  readonly failureIds: () => ReadonlyArray<string>;
} {
  const transport = createLiveChatCompletionAcknowledgementTransport(
    "fatal-close-notification",
  );
  const notifications = createAppLocalNotificationsStore(
    "fatal-close-notification-store",
  );
  notifications.getState().activateIdentity("user-1");
  const callbackHistory: ChatStreamCallbacks[] = [];
  const handle = createChatSessionStoreWithNotificationDependencies(
    {
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId,
      epicId: "epic-1",
      chatId: "chat-1",
      userId: "user-1",
      onAuthError: null,
      onProviderAuthError: null,
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, callbacks) => {
        callbackHistory.push(callbacks);
        return {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        };
      },
      ...notificationOption,
    },
    {
      completionAcknowledgements: transport,
      appLocalNotifications: notifications,
    },
  );
  disposers.push(() => {
    handle.store.getState().dispose();
    transport.dispose();
  });
  return {
    callbacks: () => {
      const callbacks = callbackHistory.at(-1);
      if (callbacks === undefined) throw new Error("Expected chat callbacks");
      return callbacks;
    },
    failureIds: () => Object.keys(notifications.getState().byId),
  };
}

function closeFatally(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus(
    "closed",
    {
      kind: "fatalError",
      details: {
        code: "CONNECTION_LOST",
        reason: "Connection lost",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    },
    null,
  );
}

describe("a chat session's fatal close notification", () => {
  it("raises the stream failure notification when the option is absent", () => {
    const session = buildSession("host-1", {});

    closeFatally(session.callbacks());

    expect(session.failureIds()).toEqual([failureId("host-1")]);
  });

  it("raises none for a session whose surface says the failure itself", () => {
    const session = buildSession("host-1", {
      fatalCloseNotification: "silent",
    });

    closeFatally(session.callbacks());

    expect(session.failureIds()).toEqual([]);
  });

  it("raises none for a host a member destroyed, whose session ends as a revocation", () => {
    recordEndedSandboxHost("host-1", {
      name: "e2e-sbx-win2",
      at: 1_000,
      actor: { userId: "user-1", displayName: null },
    });
    const session = buildSession("host-1", {});

    closeFatally(session.callbacks());

    expect(session.failureIds()).toEqual([]);
  });

  it("still raises for a host that was not destroyed", () => {
    recordEndedSandboxHost("host-1", {
      name: "e2e-sbx-win2",
      at: 1_000,
      actor: { userId: "user-1", displayName: null },
    });
    const session = buildSession("host-2", {});

    closeFatally(session.callbacks());

    expect(session.failureIds()).toEqual([failureId("host-2")]);
  });
});
