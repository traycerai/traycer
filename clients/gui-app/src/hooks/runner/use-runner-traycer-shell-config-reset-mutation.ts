import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Returns to the system default by clearing only the selection; remembered
 * shells and their flags are kept (the login shell's entry is inherited). Only
 * the shell config changes, so just that query is invalidated.
 */
export function useRunnerTraycerShellConfigResetMutation(): UseMutationResult<
  void,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void>({
    mutationKey: runnerMutationKeys.traycerShellConfigReset(),
    mutationFn: () => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.shellConfigReset();
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerShellConfig(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to reset shell config");
    },
  });
}
