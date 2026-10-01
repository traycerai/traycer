import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostRefusesEpicStore } from "@/hooks/chats/use-host-refuses-epic-store";
import { makeChatOpenTileRef } from "@/lib/chats/chat-open-tile-ref";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import type {
  EpicCanvasTileRef,
  OpenableEpicNodeKind,
} from "@/stores/epics/canvas/types";

/**
 * The tile ref an agent row opens: the Agents tree's rows and the strip's live
 * agents list (D9) both open through it, so a row means the same tile on both.
 *
 * The tab must bind to the chat's OWNER host, not whichever host happens to
 * be active: a connected peer host's chat reaches the tree through the shared
 * projection, and binding it to the active host would open a tab that asks
 * the wrong machine for the transcript. Downstream already honors the ref's
 * hostId (`renderTile` wraps each ref in its own `TabHostProvider`), so the
 * owner id is all that was missing. The FALLBACK for a row that carries no
 * owner is the Epic SESSION's host - the host that projected the row - never
 * the app-wide one, which during a re-point is a different machine from the
 * one the tree is showing.
 */
export function useChatRowOpenRef(args: {
  readonly epicId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly openableType: OpenableEpicNodeKind | null;
  readonly ownerHostId: string | null;
  readonly ownerUserId: string | null;
  readonly sessionHostId: string | null;
}): () => EpicCanvasTileRef {
  const {
    epicId,
    nodeId,
    nodeName,
    openableType,
    ownerHostId,
    ownerUserId,
    sessionHostId,
  } = args;
  const openHostId = ownerHostId ?? sessionHostId ?? UNKNOWN_HOST_PLACEHOLDER;
  // The host that SERVES a published copy's read (the owner is unreachable by
  // construction there) - the session's, for the reason above.
  const readingHostId = sessionHostId ?? UNKNOWN_HOST_PLACEHOLDER;
  // Same rule the cloud rows follow (user ruling: offline hosts show as
  // readonly with a locked composer): a CHAT row whose owner host is
  // unreachable opens the published copy, not a live tab that dials a dead
  // host into a banner. Falls back to the live ref when the identity triple
  // cannot be built (no owner user on the record) - a click always opens
  // something.
  const ownerReachability = useHostReachability(
    ownerHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  // The other reason a reachable owner cannot serve the live chat: its build
  // is older than this epic's store. Same source `ChatRowButton`'s lock reads,
  // so the row never promises a published copy the click will not open.
  const ownerRefusesStore = useHostRefusesEpicStore(ownerHostId, epicId);
  return useCallback(
    () =>
      openableType === "chat"
        ? makeChatOpenTileRef({
            taskId: epicId,
            chatId: nodeId,
            ownerHostId,
            ownerUserId,
            ownerIsUnreachable: ownerReachability.status === "unreachable",
            ownerRefusesStore,
            name: nodeName,
            sessionHostId: readingHostId,
          })
        : {
            id: nodeId,
            instanceId: uuidv4(),
            type: openableType ?? "terminal-agent",
            name: nodeName,
            hostId: openHostId,
          },
    [
      openableType,
      ownerHostId,
      ownerUserId,
      ownerReachability.status,
      ownerRefusesStore,
      epicId,
      nodeId,
      nodeName,
      readingHostId,
      openHostId,
    ],
  );
}
