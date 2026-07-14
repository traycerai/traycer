import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Forgets a previously-added shell (`traycer config shell remove`). The backend
 * falls back to the OS default when the removed shell was the current
 * selection, so on success this invalidates both the shell config and the shell
 * list; the picker stays open and refreshes in place.
 */
export function useRunnerTraycerShellConfigRemoveMutation(): UseMutationResult<
  void,
  Error,
  { readonly path: string }
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, { readonly path: string }>({
    mutationKey: runnerMutationKeys.traycerShellConfigRemove(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.shellConfigRemove(input);
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerShellConfig(traycerCli),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerShellList(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to remove shell");
    },
  });
}
