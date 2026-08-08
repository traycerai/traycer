/**
 * Schema + factory for the `published-chat` tile: a chat read from the last
 * copy its owning host published, because that host is out of reach.
 *
 * Follows the `comm-graph` / `git-diff` precedent - non-record-backed (there is
 * no Y.Doc artifact behind it; the content comes from the cloud read), and
 * `parse` RECOMPUTES the tile id from the persisted payload rather than
 * trusting the stored value, so dedup is self-healing with no migration step.
 *
 * The id is derived from the whole identity TRIPLE because `chatId` alone does
 * not identify a chat under a task: two hosts can mint the same one, and a fork
 * leaves exactly that behind. Deriving from `chatId` alone would make a
 * published copy and a live session collide in `findOpenArtifactInTab`, which
 * matches on id and nothing else.
 */
import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { TILE_KIND_PUBLISHED_CHAT } from "../tile-kinds";
import type { PublishedChatTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const PUBLISHED_CHAT_TILE_FALLBACK_NAME = "Untitled chat";

/**
 * The tile id for one published chat.
 *
 * Prefixed so it can never be mistaken for - or collide with - a live chat
 * tile, whose id is the bare `chatId`. That is the whole point: after a fork
 * the two carry the same `chatId`, and both have to be openable at once.
 */
export function publishedChatTileId(identity: {
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly chatId: string;
}): string {
  return `published-chat:${identity.taskId}:${identity.ownerUserId}:${identity.chatId}`;
}

export function makePublishedChatTileRef(input: {
  readonly taskId: string;
  readonly chatId: string;
  readonly ownerUserId: string;
  readonly ownerHostId: string;
  readonly name: string;
  /** The host serving the cloud read - this tab's own, never the owner's. */
  readonly hostId: string;
}): PublishedChatTileRef {
  return {
    id: publishedChatTileId(input),
    instanceId: uuidv4(),
    type: TILE_KIND_PUBLISHED_CHAT,
    name: input.name,
    hostId: input.hostId,
    taskId: input.taskId,
    chatId: input.chatId,
    ownerUserId: input.ownerUserId,
    ownerHostId: input.ownerHostId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePublishedChatTileRef(
  value: unknown,
): PublishedChatTileRef | null {
  if (!isRecord(value)) return null;
  if (value.type !== TILE_KIND_PUBLISHED_CHAT) return null;
  // The triple is the identity, so a ref missing any leg addresses nothing and
  // is dropped rather than rehydrated into a tile that can only fail its read.
  const taskId = readNonEmptyString(value.taskId);
  const chatId = readNonEmptyString(value.chatId);
  const ownerUserId = readNonEmptyString(value.ownerUserId);
  if (taskId === null || chatId === null || ownerUserId === null) return null;
  return {
    id: publishedChatTileId({ taskId, ownerUserId, chatId }),
    instanceId: readTileInstanceId(value.instanceId),
    name: readNonEmptyString(value.name) ?? PUBLISHED_CHAT_TILE_FALLBACK_NAME,
    type: TILE_KIND_PUBLISHED_CHAT,
    hostId: readNonEmptyString(value.hostId) ?? UNKNOWN_HOST_PLACEHOLDER,
    taskId,
    chatId,
    ownerUserId,
    // Unlike the triple, a missing owner only costs the composer's reason its
    // host name - the read still resolves - so it degrades instead of dropping
    // the tab a user had open.
    ownerHostId: readNonEmptyString(value.ownerHostId) ?? "",
  };
}

function serializePublishedChatTileRef(
  ref: PublishedChatTileRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    taskId: ref.taskId,
    chatId: ref.chatId,
    ownerUserId: ref.ownerUserId,
    ownerHostId: ref.ownerHostId,
  };
}

export const publishedChatTileSchema: TileSchema<PublishedChatTileRef> = {
  parse: parsePublishedChatTileRef,
  serialize: serializePublishedChatTileRef,
  isRecordBacked: false,
};
