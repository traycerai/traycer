import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatSessionStoreHandle,
  SendChatSessionMessageInput,
} from "@/stores/chats/chat-session-store";
import { createTestChatSession } from "@/stores/chats/test-support/create-test-chat-session";
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

let session: ChatSessionStoreHandle | null = null;

afterEach(() => {
  session?.dispose();
  session = null;
});

describe("useChatActions deliveryPolicy threading", () => {
  it("forwards deliveryPolicy to the chat session store sendMessage", () => {
    const sendMessage = vi.fn((_input: SendChatSessionMessageInput) => ({
      clientActionId: "action-1",
      messageId: "message-1",
    }));
    const handle = createTestChatSession();
    session = handle;
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
  });
});
