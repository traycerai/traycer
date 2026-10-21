import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  heldEnvironmentArmChats,
  subscribeHeldEnvironmentArmChats,
} from "@/hooks/environment/use-environment-arms";
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
 * already holds, and never a request of its own.
 *
 * Read as an external store over the query cache and the held arms: the
 * compiled renderer memoizes a render-time read on its arguments, and the
 * query client keeps one identity while its cache fills, so a list that
 * arrived after the first render was never read.
 */
export function useChatSearchCoverage(
  searchHostId: string | null,
  epicId: string | null,
): ChatSearchCoverage {
  const queryClient = useQueryClient();
  const viewerId = useCloudChatViewerId();
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const unsubscribeCache = queryClient.getQueryCache().subscribe(listener);
      const unsubscribeArms = subscribeHeldEnvironmentArmChats(listener);
      return () => {
        unsubscribeCache();
        unsubscribeArms();
      };
    },
    [queryClient],
  );
  const read = (): ChatSearchCoverage => {
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
  };
  return useSyncExternalStore(subscribe, read, read);
}
