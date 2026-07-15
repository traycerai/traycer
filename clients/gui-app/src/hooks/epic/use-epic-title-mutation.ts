import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

interface UpdateTitleMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

/**
 * Mutation hook for epic.updateTitle.
 * Save button enters pending state; on success a brief "Epic renamed"
 * toast appears (only mutation hook that surfaces success feedback).
 */
export function useEpicUpdateTitle() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.updateTitle",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({
        hostId: client.getActiveHostId(),
        userId: client.getRequestContextUserId(),
      }),
      onSuccess: (_response, variables, ctx: UpdateTitleMutationContext) => {
        Analytics.getInstance().track(AnalyticsEvent.TaskRenamed, {
          source: "direct_ui",
        });
        const delta = variables.epicDelta;
        if (
          ctx.userId !== null &&
          delta !== null &&
          delta.title !== undefined
        ) {
          updateEpicTitleInCloudTaskCaches(
            queryClient,
            { hostId: ctx.hostId, userId: ctx.userId },
            delta.id,
            delta.title,
          );
        }
        toast.success("Epic renamed");
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't rename epic.");
      },
    },
  });
}
