import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { TraycerShellConfigSetInput } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Updates the stored shell config. Either field may be `null` to preserve
 * the existing stored value (or fall back to the synthesised default). On
 * success, invalidates `traycerShellConfig` so the form reflects the
 * new value; the new host process picks it up on its next start.
 */
export function useRunnerTraycerShellConfigSetMutation(): UseMutationResult<
  void,
  Error,
  TraycerShellConfigSetInput
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, TraycerShellConfigSetInput>({
    mutationKey: runnerMutationKeys.traycerShellConfigSet(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.shellConfigSet(input);
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerShellConfig(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to update shell config");
    },
  });
}
