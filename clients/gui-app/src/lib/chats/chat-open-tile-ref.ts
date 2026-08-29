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
  /** Host serving the Epic projection and any published-copy cloud read. */
  readonly sessionHostId: string;
}

/**
 * Whether opening this chat must use its published read-only copy.
 *
 * An unreachable owner is not enough by itself: the published read is keyed
 * by task + owner user + chat, so a legacy row without either owner field must
 * retain the live fallback instead of constructing an unaddressable tile.
 */
export function chatOpensPublishedCopy(
  input: Pick<
    ChatOpenTileInput,
    "ownerHostId" | "ownerUserId" | "ownerIsUnreachable"
  > & { readonly isChat: boolean },
): boolean {
  return (
    input.isChat &&
    input.ownerHostId !== null &&
    input.ownerUserId !== null &&
    input.ownerIsUnreachable
  );
}

/**
 * Chooses a chat tile once, at open time.
 *
 * Reachable chats stay live and bind to their persisted owner for the tile's
 * lifetime. Unreachable chats with a complete cloud identity open the last
 * published copy, served through the Epic session host. Legacy / optimistic
 * rows without an owner keep the session-host live fallback.
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
