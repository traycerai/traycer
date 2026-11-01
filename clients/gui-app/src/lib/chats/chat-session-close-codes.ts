/**
 * Mirrors `ChatSessionAccessError`'s code on the host
 * (`traycer-host/src/domain/chat/chat-session-manager.ts`) - deliberately the
 * SAME code for "this chat does not exist" and "you are not its owner" (an
 * enumeration-oracle guard: a non-owner probing chat ids must not be able to
 * tell the two apart).
 */
export const CHAT_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";

/**
 * The pool's `chat.subscribe` refusal for a chat at rest its index cannot open
 * (not yet indexed, or parked: `reason` is `unindexed` or `parked`). The
 * pool serves the whole-download pair (`epic.resolveCloudChatHead`,
 * `epic.readCloudChatPart`) for exactly this case, so the tab reads the
 * published copy through the pool instead.
 */
export const CHAT_INDEX_UNAVAILABLE_CODE = "CHAT_INDEX_UNAVAILABLE";
