import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  useIsActiveEpicArtifact,
  useIsActiveTile,
} from "@/stores/epics/canvas/store";
import { publishedChatTileId } from "@/stores/epics/canvas/tile-schema/published-chat-tile";

/**
 * Whether this tab is showing THIS row's chat - in either of the two forms a
 * click on the row can open it. A live open is an ordinary record-backed chat
 * tile, so it matches by artifact id; the bare-chatId match shares the
 * documented bounded same-minted-chatId collision the union byId already
 * carries. A published copy is deliberately NOT record-backed, so the artifact
 * selector reads null for it and only its composite tile id can match.
 */
export function useCloudChatRowActive(
  tabId: string,
  chat: CloudChatSummary,
): boolean {
  const isActiveLive = useIsActiveEpicArtifact(tabId, chat.identity.chatId);
  const isActivePublished = useIsActiveTile(
    tabId,
    publishedChatTileId(chat.identity),
    null,
  );
  return isActiveLive || isActivePublished;
}
