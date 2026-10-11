import { createContext, use, useMemo } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { ChatRowSnapshot } from "@/stores/chats/chat-row-store";
import type { ChatMessage } from "@/stores/composer/chat-store";
import type { RenderedMessagesDisplayContext } from "@/stores/chats/rendered-messages";

export const ChatRowStoreContext =
  createContext<StoreApi<ChatRowSnapshot> | null>(null);
export const ChatRowPresentationContext = createContext<{
  readonly display: RenderedMessagesDisplayContext;
  readonly viewTabId: string;
} | null>(null);

export function usePresentedChatMessage(message: ChatMessage): ChatMessage {
  const presentation = use(ChatRowPresentationContext);
  return useMemo(() => {
    if (presentation === null) return message;
    const { display, viewTabId } = presentation;
    const meta = message.assistantMeta;
    const sender = meta?.sender;
    return {
      ...message,
      senderLabel:
        message.sender === null || message.sender === undefined
          ? message.senderLabel
          : display.resolveUserSenderLabel(message.sender),
      assistantMeta:
        meta === null || sender === undefined
          ? meta
          : {
              ...meta,
              ...display.resolveAgentSenderDisplay(sender),
              reasoningEffortLabel: display.resolveAgentReasoningLabel(
                sender,
                meta.reasoningEffort,
              ),
            },
      segments: message.segments.map((segment) =>
        segment.kind === "setup-card" || segment.kind === "forked-chat-link"
          ? { ...segment, viewTabId }
          : segment,
      ),
    };
  }, [message, presentation]);
}
