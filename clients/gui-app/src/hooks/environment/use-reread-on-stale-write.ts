import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { staleWriteOf } from "@/lib/environment/stale-write";
import { queryKeys } from "@/lib/query-keys";

/**
 * Re-reads `hostId`'s settings when a save made through it loses to a newer
 * change (`ENVIRONMENT_WRITE_STALE`). The save's own `onSuccess` invalidation
 * never runs on a refusal, so without this the page would keep showing the
 * value the save was based on, and a second save would be stale too.
 *
 * Watches the mutation cache rather than each save hook, so every save on the
 * page is covered by one subscription, including ones added later.
 */
export function useRereadOnStaleWrite(hostId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (hostId === null) return undefined;
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (staleWriteOf(event.action.error) === null) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostScope(hostId),
      });
    });
  }, [hostId, queryClient]);
}
