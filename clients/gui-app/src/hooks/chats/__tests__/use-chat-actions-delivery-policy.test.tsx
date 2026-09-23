import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatSessionStoreHandle,
  SendChatSessionMessageInput,
} from "@/stores/chats/chat-session-store";
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
  identityId: null,
};

/**
 * DERIVED from the store's own parameter, not restated. This fake is why that
 * matters: a hand-typed copy of `sendMessage`'s input drifted from production
 * and, because the only thing `tsc` checks is the object literal the proxy
 * builds, it stayed green through a compile and reached committed history RED.
 */
interface SendMessageStoreSlice {
  readonly sendMessage: (
    input: SendChatSessionMessageInput,
  ) => { readonly clientActionId: string; readonly messageId: string } | null;
}

describe("useChatActions deliveryPolicy threading", () => {
  it("forwards deliveryPolicy to the chat session store sendMessage", () => {
    const sendMessage = vi.fn((_input: SendChatSessionMessageInput) => ({
      clientActionId: "action-1",
      messageId: "message-1",
    }));
    const storeSlice: SendMessageStoreSlice = { sendMessage };
    const handle = createDeliveryPolicyHandle(storeSlice);

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
  });
});

function createDeliveryPolicyHandle(
  storeSlice: SendMessageStoreSlice,
): ChatSessionStoreHandle {
  const store = {
    getState: () => storeSlice,
  } as ChatSessionStoreHandle["store"];
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    userId: null,
    store,
    deliveredNotices: {
      notices: new WeakSet(),
      clientActionIds: new Set(),
      retainedClientActionIds: new Set(),
    },
    deliveredRestoreCompletionKeys: new Set(),
    setSurfaceVisibility: (_surfaceId: string, _visible: boolean) => undefined,
    clearSurfaceVisibility: (_surfaceId: string) => undefined,
    dispose: () => undefined,
  };
}
