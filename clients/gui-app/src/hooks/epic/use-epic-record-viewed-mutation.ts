import { useQueryClient } from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { cloudEpicTasksLastViewedQueryKeyMatchesScope } from "@/lib/cloud-epic-tasks-query/cache";
import { epicMutationKeys } from "@/lib/query-keys";
import { resetLastViewedCloudEpicTasksPagesForScope } from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Thrown from `onMutate` when the session holds no cloud verdict at dispatch.
 *
 * `epic.recordViewed` writes personal cloud recency through a local-host
 * connection that carries no renderer verdict of its own, and its one caller
 * is a passive route effect gated on a RENDER-time verdict. React can flush
 * an already-committed effect before it renders the store update that
 * withdrew the verdict, so the render gate alone lets a demotion that lands
 * between commit and effect dispatch on a bearer the cloud stopped vouching
 * for. Re-read here, at dispatch, in the one mutation every caller shares -
 * the same shape as `EPIC_PIN_UNAUTHORIZED_MESSAGE`.
 */
export const EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE =
  "record-viewed refused: the session holds no cloud verdict";

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
      onMutate: (): RecordEpicViewedMutationContext => {
        if (!authorizesCloudCapability(useAuthStore.getState().status)) {
          throw new Error(EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE);
        }
        return {
          hostId: client.getActiveHostId(),
          userId: client.getRequestContextUserId(),
        };
      },
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
      // interrupt navigation with a toast - nor should the dispatch-time
      // refusal above, which is the route's own decision made late.
    },
  });
}
