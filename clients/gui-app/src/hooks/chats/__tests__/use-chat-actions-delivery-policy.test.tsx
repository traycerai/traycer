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
import type { Attachment } from "@/lib/composer/types";

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
  readonly sendMessage: (input: {
    readonly content: JsonContent;
    readonly sender: UserMessageSender;
    readonly settings: ChatRunSettings;
    readonly attachments: ReadonlyArray<Attachment>;
    readonly deliveryPolicy: ChatQueueDeliveryPolicy;
    readonly restore: {
      readonly content: JsonContent;
      readonly browserAnnotations: ReadonlyArray<unknown>;
    };
  }) => { readonly clientActionId: string; readonly messageId: string } | null;
}

describe("useChatActions deliveryPolicy threading", () => {
  it("forwards deliveryPolicy to the chat session store sendMessage", () => {
    const sendMessage = vi.fn(
      (_input: {
        readonly content: JsonContent;
        readonly sender: UserMessageSender;
        readonly settings: ChatRunSettings;
        readonly attachments: ReadonlyArray<Attachment>;
        readonly deliveryPolicy: ChatQueueDeliveryPolicy;
        readonly restore: {
          readonly content: JsonContent;
          readonly browserAnnotations: ReadonlyArray<unknown>;
        };
      }) => ({
        clientActionId: "action-1",
        messageId: "message-1",
      }),
    );
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
