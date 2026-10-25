import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { PushSeverity } from "@traycer-clients/shared/platform/runner-host";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

export type PushMutedSeveritiesMutation = UseMutationResult<
  void,
  Error,
  readonly PushSeverity[]
>;

/**
 * Stores the WHOLE new muted set on this phone. It resolves once the phone has
 * kept it; sending it to the server is the phone's own best-effort business.
 * The mutation stays pending until the query has re-read the stored set, so a
 * switch is never enabled showing the value from before the change.
 */
export function usePushMutedSeveritiesMutation(): PushMutedSeveritiesMutation {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();
  return useMutation<void, Error, readonly PushSeverity[]>({
    mutationKey: runnerMutationKeys.pushMutedSeveritiesSet(),
    mutationFn: (set) => {
      if (pushPermission === null) {
        throw new Error("This phone has no push notifications to change.");
      }
      return pushPermission.setMutedSeverities(set);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushMutedSeverities(),
      }),
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't change this phone's notifications"),
  });
}
