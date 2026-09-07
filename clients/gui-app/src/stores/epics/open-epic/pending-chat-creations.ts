/** Chats this client has had a host CREATE, for as long as no record for them has arrived back. */
import type { ChatProjection, ChatsSlice } from "./types";
import { isChatVisibleToUser } from "./projection-helpers";

/**
 * What a creation surface knows at submit time, INCLUDING the owner it was authorized as - see
 * `ownerUserId`. The store stamps only what it alone knows: the timestamps, from the clock.
 */
export interface PendingChatCreation {
  /**
   * The created chat. Client-minted and echoed by the resolver, so the request,
   * the response and the record that eventually arrives all name it.
   */
  readonly chatId: string;
  /** The host the chat is being created on - NOT whichever host is active. */
  readonly hostId: string;
  readonly parentChatId: string | null;
  /** The submitted title, normally `""` ("no title yet"). */
  readonly title: string;
  /**
   * The signed-in user the create was authorized as, captured by the caller when the request left -
   * NOT whoever is signed in when it is retained.
   */
  readonly ownerUserId: string | null;
}

/** A pending creation as retained: the caller's facts plus the store's stamp. */
export interface RetainedChatCreation {
  readonly pending: PendingChatCreation;
  /** The signed-in user at registration. */
  readonly ownerUserId: string;
  readonly createdAt: number;
}

/** A pending creation in the renderer's chat shape. */
export function chatProjectionFromPendingCreation(
  retained: RetainedChatCreation,
): ChatProjection {
  return {
    id: retained.pending.chatId,
    title: retained.pending.title,
    parentId: retained.pending.parentChatId,
    createdAt: retained.createdAt,
    updatedAt: retained.createdAt,
    userId: retained.ownerUserId,
    hostId: retained.pending.hostId,
    isTitleEditedByUser: false,
    // Stamping `null` here instead would disable rename on the row the user just created, in exactly
    // the window the create-then-rename flow lives in.
    docResident: false,
    settings: null,
    archivedAt: null,
  };
}

/** The record slice with every still-pending creation folded in. */
export function unionPendingChatCreations(
  records: ChatsSlice,
  retained: Iterable<RetainedChatCreation>,
  currentUserId: string | null,
): ChatsSlice {
  let byId: Record<string, ChatProjection> | null = null;
  let allIds: string[] | null = null;
  for (const entry of retained) {
    const { chatId } = entry.pending;
    if (Object.hasOwn(records.byId, chatId)) continue;
    if (!isChatVisibleToUser(entry.ownerUserId, currentUserId)) continue;
    if (byId === null || allIds === null) {
      byId = { ...records.byId };
      allIds = [...records.allIds];
    }
    if (Object.hasOwn(byId, chatId)) continue;
    byId[chatId] = chatProjectionFromPendingCreation(entry);
    allIds.push(chatId);
  }
  if (byId === null || allIds === null) return records;
  return { byId, allIds };
}
