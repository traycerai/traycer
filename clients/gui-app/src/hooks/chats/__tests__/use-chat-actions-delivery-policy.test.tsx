import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { SendChatSessionMessageInput } from "@/stores/chats/chat-session-store";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useChatActions } from "@/hooks/chats/use-chat-actions";

/**
 * Pins that `useChatActions.sendMessage` forwards `deliveryPolicy` to the
 * session store (the chat-tile submit path threads it through this hook).
 */

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

describe("useChatActions deliveryPolicy threading", () => {
  it("forwards deliveryPolicy to the chat session store sendMessage", () => {
    const sendMessage = vi.fn((_input: SendChatSessionMessageInput) => ({
      clientActionId: "action-1",
      messageId: "message-1",
    }));
    const handle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: "host-1",
      epicId: "epic-1",
      chatId: "chat-1",
      userId: null,
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
    handle.store.setState({ sendMessage });

    const { result } = renderHook(() => useChatActions(handle));
    result.current.sendMessage({
      content: CONTENT,
      sender: { type: "user", userId: "owner-1" },
      settings: SETTINGS,
      attachments: [],
      deliveryPolicy: "after_safe_point",
      restore: { content: CONTENT, browserAnnotations: [] },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      content: CONTENT,
      sender: { type: "user", userId: "owner-1" },
      settings: SETTINGS,
      attachments: [],
      deliveryPolicy: "after_safe_point",
      restore: { content: CONTENT, browserAnnotations: [] },
    });
    handle.dispose();
  });
});
