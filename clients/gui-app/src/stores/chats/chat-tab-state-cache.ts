import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import {
  deleteReadingPositionView,
  deleteReadingPositionsForContent,
  deleteReadingPositionsForEpic,
  readExactReadingPosition,
  readReadingPosition,
  saveReadingPosition,
  saveReadingPositionContentFallback,
} from "@/lib/reading-position/service";
import { readingPositionIdentityForChat } from "@/lib/reading-position/chat-identity";

export type ChatTabScrollMode = "following-end" | "free-scrolling";

export interface SavedChatTabScrollState {
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  readonly anchorIndex: number | null;
  readonly offset: number;
}

const DEFAULT_CHAT_TAB_SCROLL_STATE: SavedChatTabScrollState = {
  mode: "following-end",
  anchorMessageId: null,
  anchorIndex: null,
  offset: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSavedChatTabScrollState(
  value: unknown,
): value is SavedChatTabScrollState {
  if (!isRecord(value)) return false;
  return (
    (value.mode === "following-end" || value.mode === "free-scrolling") &&
    (typeof value.anchorMessageId === "string" ||
      value.anchorMessageId === null) &&
    (typeof value.anchorIndex === "number" || value.anchorIndex === null) &&
    (value.anchorIndex === null || Number.isFinite(value.anchorIndex)) &&
    typeof value.offset === "number" &&
    Number.isFinite(value.offset)
  );
}

/** Raw, unclamped state: exact view first, then durable content fallback. */
export function peekSavedChatTabState(
  identity: ChatTabPersistenceIdentity,
): SavedChatTabScrollState | null {
  return readReadingPosition(
    readingPositionIdentityForChat(identity),
    "chat",
    isSavedChatTabScrollState,
  );
}

export function restoreChatTabState(
  identity: ChatTabPersistenceIdentity,
  messages: ReadonlyArray<ChatMessageModel>,
): SavedChatTabScrollState {
  const saved = peekSavedChatTabState(identity);
  if (saved === null) return DEFAULT_CHAT_TAB_SCROLL_STATE;
  if (saved.anchorMessageId === null) return saved;
  if (messages.some((message) => message.id === saved.anchorMessageId)) {
    return saved;
  }
  if (messages.length === 0 || saved.anchorIndex === null) {
    return {
      mode: saved.mode,
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    };
  }
  const clampedIndex = Math.min(
    Math.max(Math.trunc(saved.anchorIndex), 0),
    messages.length - 1,
  );
  return {
    mode: saved.mode,
    anchorMessageId: messages[clampedIndex].id,
    anchorIndex: clampedIndex,
    offset: 0,
  };
}

export interface SaveChatTabStateInput extends SavedChatTabScrollState {
  readonly identity: ChatTabPersistenceIdentity;
}

export function saveChatTabState(input: SaveChatTabStateInput): void {
  const { identity, ...anchor } = input;
  saveReadingPosition(readingPositionIdentityForChat(identity), "chat", anchor);
}

export function commitChatTabStateToDurable(
  input: SaveChatTabStateInput,
): void {
  const { identity, ...anchor } = input;
  saveReadingPositionContentFallback(
    readingPositionIdentityForChat(identity),
    "chat",
    anchor,
  );
}

export function promoteChatTabStateToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const globalIdentity = readingPositionIdentityForChat(identity);
  const exact = readExactReadingPosition(
    globalIdentity,
    "chat",
    isSavedChatTabScrollState,
  );
  if (exact === null) return;
  saveReadingPositionContentFallback(globalIdentity, "chat", exact);
}

export function evictChatTabState(keys: ReadonlyArray<string>): void {
  keys.forEach(deleteReadingPositionView);
}

export function evictChatTabStateForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  deleteReadingPositionsForContent(
    readingPositionIdentityForChat({
      ...identity,
      tileInstanceId: `deleted-chat:${identity.chatId}`,
    }),
  );
}

export function evictChatTabStateForEpic(epicId: string): void {
  deleteReadingPositionsForEpic(epicId);
}
