import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

export type PushRegistrationRetryMutation = UseMutationResult<
  void,
  Error,
  void
>;

export function usePushRegistrationRetryMutation(): PushRegistrationRetryMutation {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: runnerMutationKeys.pushRegistrationRetry(),
    mutationFn: async () => {
      if (pushPermission === null)
        throw new Error("Push notifications are unavailable.");
      await pushPermission.retryRegistration();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushPermission(),
      });
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't retry push notifications"),
  });
}
