import { useQueryClient } from "@tanstack/react-query";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { heldEnvironmentArmChats } from "@/hooks/environment/use-environment-arms";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  chatSearchCoverage,
  heldTeamEnvironmentIds,
  heldViewerTaskChats,
  type ChatSearchCoverage,
} from "@/lib/chat-search/chat-search-coverage";

/**
 * The coverage of a search answered by `searchHostId` over `epicId` (`null`
 * for every task), from the chat lists and environment arms this client
 * already holds. Read on every render of the results, and never a request of
 * its own.
 */
export function useChatSearchCoverage(
  searchHostId: string | null,
  epicId: string | null,
): ChatSearchCoverage {
  const queryClient = useQueryClient();
  const viewerId = useCloudChatViewerId();
  if (viewerId.length === 0 || epicId === null) {
    return chatSearchCoverage({
      searchHostId,
      viewerId,
      epicId: null,
      viewerChats: null,
      arms: null,
    });
  }
  const arms =
    readProcessHostRpcTierPlan().pool === null
      ? null
      : {
          teamEnvironmentIds: heldTeamEnvironmentIds(queryClient, viewerId),
          ...heldEnvironmentArmChats(viewerId, epicId),
        };
  return chatSearchCoverage({
    searchHostId,
    viewerId,
    epicId,
    viewerChats: heldViewerTaskChats(queryClient, viewerId, epicId),
    arms,
  });
}
