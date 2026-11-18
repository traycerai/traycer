import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

interface SetEnvOverrideInput {
  readonly key: string;
  readonly value: string | null;
}

/**
 * Inserts or updates a single env override. The host picks up the new
 * value on its next bootstrap (the CLI's `host start` reads the table
 * before exec'ing the bundle).
 */
export function useRunnerTraycerEnvOverrideSetMutation(): UseMutationResult<
  void,
  Error,
  SetEnvOverrideInput
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, SetEnvOverrideInput>({
    mutationKey: runnerMutationKeys.traycerEnvOverrideSet(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.envOverrideSet(input);
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerEnvOverrideList(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to save env override");
    },
  });
}
