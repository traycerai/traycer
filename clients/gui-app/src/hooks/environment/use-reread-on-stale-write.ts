import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  CONFIGURATION_READS,
  invalidateConfigurationReads,
} from "@/hooks/environment/environment-host-list-key";
import { staleWriteOf } from "@/lib/environment/stale-write";
import { queryKeys } from "@/lib/query-keys";

/**
 * Re-reads a page's settings when a save on it loses to a newer change
 * (`ENVIRONMENT_WRITE_STALE`): `hostId`'s own reads, and the configuration
 * reads of `environmentId` on every host that read them. The save's own
 * `onSuccess` invalidation never runs on a refusal, so without this the page
 * would keep showing the value the save was based on, and a second save would
 * be stale too. A typed refusal (`conflict`, `stale`, `refused`) is an
 * answer, and each configuration write rereads on every answer.
 *
 * Watches the mutation cache rather than each save hook, so every save on the
 * page is covered by one subscription, including ones added later.
 */
export function useRereadOnStaleWrite(
  hostId: string | null,
  environmentId: string | null,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (hostId === null && environmentId === null) return undefined;
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (staleWriteOf(event.action.error) === null) return;
      if (hostId !== null)
        void queryClient.invalidateQueries({
          queryKey: queryKeys.hostScope(hostId),
        });
      if (environmentId !== null)
        invalidateConfigurationReads(
          queryClient,
          environmentId,
          CONFIGURATION_READS,
        );
    });
  }, [hostId, environmentId, queryClient]);
}
