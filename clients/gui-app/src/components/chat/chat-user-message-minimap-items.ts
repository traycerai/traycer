import type { Attachment } from "@/lib/composer/types";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { JsonContent } from "@traycer/protocol/common/registry";

// Contract between the chat scroll region (producer) and the minimap overlay
// (consumer): the expanded overlay caps its size to the marked region so it
// never spills past the clipped message area. Both the marker and the selector
// derive from one attribute name, resolved by `closest` so the lookup survives
// any wrapper added between the two.
const CHAT_MINIMAP_CLIP_REGION_ATTRIBUTE = "data-chat-minimap-clip-region";

export const chatMinimapClipRegionProps = {
  [CHAT_MINIMAP_CLIP_REGION_ATTRIBUTE]: "true",
} as const;

export const CHAT_MINIMAP_CLIP_REGION_SELECTOR = `[${CHAT_MINIMAP_CLIP_REGION_ATTRIBUTE}="true"]`;

/**
 * Shared shape of one minimap rail entry. Built by
 * `buildChatUserMessageMinimapItems` below from the rendered rows (ids ARE
 * the rendered row ids, so minimap clicks resolve directly against the
 * Virtuoso data) and consumed by `chat-user-message-minimap.tsx`.
 */
export interface ChatUserMinimapItem {
  readonly id: string;
  readonly content: string;
  readonly structuredContent: JsonContent | null;
  readonly attachments: ReadonlyArray<Attachment>;
}

export function buildChatUserMessageMinimapItems(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatUserMinimapItem> {
  const items: ChatUserMinimapItem[] = [];
  for (const message of messages) {
    // A2A responses received from other agents are persisted as `role: "user"`
    // but carry `agentSenderInfo`; they are operational agent traffic, not
    // user-authored prompts, so they must not appear in the user-message index.
    if (message.role !== "user" || message.agentSenderInfo !== null) continue;
    items.push({
      id: message.id,
      content: message.content,
      structuredContent: message.structuredContent,
      attachments: message.attachments,
    });
  }
  return items;
}
