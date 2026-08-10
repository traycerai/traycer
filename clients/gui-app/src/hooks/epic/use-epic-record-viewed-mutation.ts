import { useQueryClient } from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { cloudEpicTasksLastViewedQueryKeyMatchesScope } from "@/lib/cloud-epic-tasks-query/cache";
import { epicMutationKeys } from "@/lib/query-keys";
import { resetLastViewedCloudEpicTasksPagesForScope } from "@/stores/epics/cloud-epic-tasks-pages-store";

interface RecordEpicViewedMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

/** Records task recency through the default host used by Task History. */
export function useEpicRecordViewed() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.recordViewed",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.recordViewed(),
      onMutate: (): RecordEpicViewedMutationContext => ({
        hostId: client.getActiveHostId(),
        userId: client.getRequestContextUserId(),
      }),
      onSuccess: async (_response, _variables, context) => {
        if (context.hostId === null || context.userId === null) return;
        const scope = { hostId: context.hostId, userId: context.userId };
        resetLastViewedCloudEpicTasksPagesForScope(
          context.hostId,
          context.userId,
        );
        queryClient.removeQueries({
          type: "inactive",
          predicate: (query) =>
            cloudEpicTasksLastViewedQueryKeyMatchesScope(query.queryKey, scope),
        });
        await queryClient.invalidateQueries({
          type: "active",
          predicate: (query) =>
            cloudEpicTasksLastViewedQueryKeyMatchesScope(query.queryKey, scope),
        });
      },
      // Viewing is background telemetry-like state. Older hosts expose this
      // optional method as unsupported, and transient failures should not
      // interrupt navigation with a toast.
    },
  });
}
