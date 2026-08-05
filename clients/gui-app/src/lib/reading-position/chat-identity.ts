import type { ReadingPositionIdentity } from "@/lib/reading-position/types";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";

export function readingPositionIdentityForChat(
  identity: ChatTabPersistenceIdentity,
): ReadingPositionIdentity {
  const hostId = identity.hostId ?? null;
  const contentKey = ["chat", hostId ?? "unknown-host", identity.chatId]
    .map(encodeURIComponent)
    .join(":");
  const deletionKey = ["chat", identity.chatId]
    .map(encodeURIComponent)
    .join(":");
  return {
    viewKey: identity.tileInstanceId,
    contentKey,
    deletionKey,
    epicId: identity.epicId,
    hostId,
    durability: "durable",
  };
}
