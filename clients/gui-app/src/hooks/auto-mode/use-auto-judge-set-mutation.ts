import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSetRequest,
  AutoJudgeSetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { autoModeMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type SetAutoJudgeContext = {
  readonly hostId: string | null;
};

/**
 * Writes this host's judge selection.
 *
 * The read is updated in place from the response rather than invalidated: the
 * picker commits on every model / provider / profile click, and a refetch per
 * click would re-answer a question this response already settled - and would do
 * it a frame later, snapping the trigger back to the previous selection in
 * between. `hostId` is captured in `onMutate` so a surface whose host moved
 * mid-flight files the answer against the host that was asked.
 */
export function useAutoJudgeSetMutation(): UseMutationResult<
  AutoJudgeSetResponse,
  HostRpcError,
  AutoJudgeSetRequest,
  SetAutoJudgeContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "autoJudge.set", SetAutoJudgeContext>(
    {
      client,
      method: "autoJudge.set",
      mapVariables: (variables) => variables,
      options: {
        mutationKey: autoModeMutationKeys.setJudge(),
        onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
        onSuccess: (data, _variables, ctx) => {
          if (ctx.hostId === null) return;
          queryClient.setQueriesData<AutoJudgeGetResponse>(
            {
              queryKey: hostQueryKeys.methodScope(ctx.hostId, "autoJudge.get"),
            },
            data,
          );
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't save the Auto mode judge."),
      },
    },
  );
}
