import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
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
  readonly requester: HostRequester<HostRpcRegistry>;
  readonly epicDelta: UpdateTitleRequest["epicDelta"];
}

export function useAddressedEpicUpdateTitle() {
  return useTitleMutation<AddressedTitleWrite>(
    (variables) => variables.requester,
    ({ epicDelta }) => ({ epicDelta }),
  );
}

/**
 * Mutation hook for epic.updateTitle.
 * Save button enters pending state; on success a brief "Epic renamed"
 * toast appears (only mutation hook that surfaces success feedback).
 */
export function useEpicUpdateTitle() {
  return useTitleMutation<UpdateTitleRequest>(
    useHostClient(),
    (variables) => variables,
  );
}

function useTitleMutation<Variables>(
  client:
    | HostRequester<HostRpcRegistry>
    | ((variables: Variables) => HostRequester<HostRpcRegistry>),
  mapVariables: (variables: Variables) => UpdateTitleRequest,
) {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "epic.updateTitle",
    UpdateTitleMutationContext,
    Variables
  >({
    client,
    method: "epic.updateTitle",
    mapVariables,
    options: {
      onMutate: (variables) => {
        const requester =
          typeof client === "function" ? client(variables) : client;
        return {
          hostId: requester.getActiveHostId(),
          userId: requester.getRequestContextUserId(),
        };
      },
      onSuccess: (_response, variables, ctx: UpdateTitleMutationContext) => {
        Analytics.getInstance().track(AnalyticsEvent.TaskRenamed, {
          source: "direct_ui",
        });
        const delta = mapVariables(variables).epicDelta;
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
