import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

interface DeleteEnvOverrideInput {
  readonly key: string;
}

/**
 * Removes a single env override row. The next host bootstrap will no
 * longer set that variable (and so the user's shell-resolved value, if
 * any, takes effect again).
 */
export function useRunnerTraycerEnvOverrideDeleteMutation(): UseMutationResult<
  void,
  Error,
  DeleteEnvOverrideInput
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, DeleteEnvOverrideInput>({
    mutationKey: runnerMutationKeys.traycerEnvOverrideDelete(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.envOverrideDelete(input);
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerEnvOverrideList(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to delete env override");
    },
  });
}
