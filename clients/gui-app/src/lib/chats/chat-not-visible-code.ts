/**
 * Mirrors `ChatSessionAccessError`'s code on the host
 * (`traycer-host/src/domain/chat/chat-session-manager.ts`) - deliberately the
 * SAME code for "this chat does not exist" and "you are not its owner" (an
 * enumeration-oracle guard: a non-owner probing chat ids must not be able to
 * tell the two apart).
 */
export const CHAT_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";
