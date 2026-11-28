import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import { reconcileAuthoritativeEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { settleUnknownEpicTitleWrite } from "@/lib/epic-title-write-settlement";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host";

interface UpdateTitleMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

type UpdateTitleRequest = RequestOfMethod<HostRpcRegistry, "epic.updateTitle">;

interface AddressedTitleWrite {
  readonly requester: HostRequester<HostRpcRegistry> | null;
  readonly epicDelta: UpdateTitleRequest["epicDelta"];
}

/** The caller supplies the peer that serves the task. */
export function useEpicUpdateTitle() {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.updateTitle",
    UpdateTitleMutationContext,
    AddressedTitleWrite
  >({
    client: ({ requester }) => requester,
    method: "epic.updateTitle",
    mapVariables: ({ epicDelta }) => ({ epicDelta }),
    options: {
      onMutate: ({ requester }) => ({
        hostId: requester?.getActiveHostId() ?? null,
        userId: requester?.getRequestContextUserId() ?? null,
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
          reconcileAuthoritativeEpicTitleInCloudTaskCaches(
            queryClient,
            { hostId: ctx.hostId, userId: ctx.userId },
            delta.id,
            delta.title,
          );
        }
        toast.success("Epic renamed");
      },
      onError: (error, _variables, ctx) => {
        if (
          !settleUnknownEpicTitleWrite(
            error,
            queryClient,
            ctx?.hostId ?? null,
            ctx?.userId ?? null,
          )
        )
          toastFromHostError(error, "Couldn't rename epic.");
      },
    },
  });
}
