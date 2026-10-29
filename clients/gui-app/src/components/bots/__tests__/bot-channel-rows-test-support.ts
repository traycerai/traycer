import { createStore } from "zustand";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";

/** A member's post, as a chat's session holds it. */
export function postRow(messageId: string, text: string): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "user-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
    timestamp: 1_000,
    sessionAnchor: null,
    conversationRequest: {
      requestId: messageId,
      resolvedAt: null,
      resolvedByMessageId: null,
    },
  };
}

/** A chat's session holding the posts in `textByMessageId`, for a `ChannelPost`. */
export function chatSessionWithPosts(
  textByMessageId: Readonly<Record<string, string>>,
): ChatSessionStoreHandle {
  const store = createStore<
    Pick<
      ChatSessionState,
      "messages" | "transcriptWindow" | "holdTranscriptOrdinal"
    >
  >(() => ({
    transcriptWindow: emptyTranscriptWindow(),
    holdTranscriptOrdinal: () => () => undefined,
    messages: Object.entries(textByMessageId).map(([id, text]) =>
      postRow(id, text),
    ),
  }));
  return { store } as ChatSessionStoreHandle;
}
