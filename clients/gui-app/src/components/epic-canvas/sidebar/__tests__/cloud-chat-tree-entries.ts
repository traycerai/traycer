import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  cloudChatRowKey,
  type UnifiedCloudChatEntry,
} from "@/lib/chats/unified-chat-list";

/** `chat` as a root-list entry with nothing nested under it. */
export function leafCloudEntry(chat: CloudChatSummary): UnifiedCloudChatEntry {
  return {
    kind: "cloud",
    key: cloudChatRowKey(chat.identity),
    chat,
    children: [],
  };
}
