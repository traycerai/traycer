import { v4 as uuidv4 } from "uuid";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import type {
  EpicArtifactRef,
  PublishedChatTileRef,
} from "@/stores/epics/canvas/types";

export interface ChatOpenTileInput {
  readonly taskId: string;
  readonly chatId: string;
  readonly name: string;
  /** Persisted immutable owner. Null only for legacy / optimistic records. */
  readonly ownerHostId: string | null;
  readonly ownerUserId: string | null;
  readonly ownerIsUnreachable: boolean;
  /**
   * Whether the owner host, though reachable, has refused this chat's epic
   * store as written by a newer build (`HOST_OLDER_THAN_DATA`). Read from
   * `useHostRefusesEpicStore`, which a live tile's fatal close feeds and an
   * in-place host upgrade retires.
   */
  readonly ownerRefusesStore: boolean;
  /** Host serving the Epic projection and any published-copy cloud read. */
  readonly sessionHostId: string;
}

/**
 * Whether opening this chat must use its published read-only copy.
 *
 * Two owner states send a chat there, and they are the same state from the
 * reader's side - the live transcript cannot be had from that machine: the
 * owner is unreachable, or it is reachable but too old for the store a newer
 * host wrote into this epic. A live tile on the second one would dial into
 * the host's `HOST_OLDER_THAN_DATA` refusal, which no retry can clear.
 *
 * Neither is enough by itself: the published read is keyed by task + owner
 * user + chat, so a legacy row without either owner field must retain the
 * live fallback instead of constructing an unaddressable tile.
 */
export function chatOpensPublishedCopy(
  input: Pick<
    ChatOpenTileInput,
    "ownerHostId" | "ownerUserId" | "ownerIsUnreachable" | "ownerRefusesStore"
  > & { readonly isChat: boolean },
): boolean {
  return (
    input.isChat &&
    input.ownerHostId !== null &&
    input.ownerUserId !== null &&
    (input.ownerIsUnreachable || input.ownerRefusesStore)
  );
}

/**
 * Chooses a chat tile once, at open time.
 *
 * Reachable chats stay live and bind to their persisted owner for the tile's
 * lifetime. Chats whose owner is unreachable, or is known to refuse the epic's
 * store, open the last published copy when they carry a complete cloud
 * identity, served through the Epic session host. Legacy / optimistic rows
 * without an owner keep the session-host live fallback.
 */
export function makeChatOpenTileRef(
  input: ChatOpenTileInput,
): EpicArtifactRef | PublishedChatTileRef {
  if (
    chatOpensPublishedCopy({ ...input, isChat: true }) &&
    input.ownerHostId !== null &&
    input.ownerUserId !== null
  ) {
    return makePublishedChatTileRef({
      taskId: input.taskId,
      chatId: input.chatId,
      ownerUserId: input.ownerUserId,
      ownerHostId: input.ownerHostId,
      name: input.name,
      hostId: input.sessionHostId,
    });
  }

  return {
    id: input.chatId,
    instanceId: uuidv4(),
    type: "chat",
    name: input.name,
    hostId: input.ownerHostId ?? input.sessionHostId,
  };
}
