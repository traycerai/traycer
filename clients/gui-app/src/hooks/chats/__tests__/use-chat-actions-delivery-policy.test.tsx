import "../../../../__tests__/test-browser-apis";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueueDeliveryPolicy,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/senders";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
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
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

interface SendMessageStoreSlice {
  readonly sendMessage: (
    content: JsonContent,
    sender: UserMessageSender,
    settings: ChatRunSettings,
    deliveryPolicy: ChatQueueDeliveryPolicy,
  ) => { readonly clientActionId: string; readonly messageId: string } | null;
}

describe("useChatActions deliveryPolicy threading", () => {
  it("forwards deliveryPolicy to the chat session store sendMessage", () => {
    const sendMessage = vi.fn(
      (
        _content: JsonContent,
        _sender: UserMessageSender,
        _settings: ChatRunSettings,
        _deliveryPolicy: ChatQueueDeliveryPolicy,
      ) => ({
        clientActionId: "action-1",
        messageId: "message-1",
      }),
    );
    const storeSlice: SendMessageStoreSlice = { sendMessage };
    const handle: ChatSessionStoreHandle = {
      store: {
        getState: () => storeSlice,
      },
    } as ChatSessionStoreHandle;

    const { result } = renderHook(() => useChatActions(handle));
    result.current.sendMessage(
      CONTENT,
      { type: "user", userId: "owner-1" },
      SETTINGS,
      "after_safe_point",
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      CONTENT,
      { type: "user", userId: "owner-1" },
      SETTINGS,
      "after_safe_point",
    );
  });
});
