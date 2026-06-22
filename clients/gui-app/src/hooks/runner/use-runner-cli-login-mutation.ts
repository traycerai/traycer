import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

export interface CliLoginVariables {
  readonly token: string;
  readonly refreshToken: string;
}

/**
 * Seeds the CLI's stored credentials with the renderer's captured bearer so
 * the CLI keeps using it for host comms (and can refresh it on a 401). The
 * host pipes the token to `traycer login --token -` over stdin. Best-effort and
 * silent on error - failure does not affect the signed-in renderer, and the CLI
 * self-refreshes as a fallback - so the local-host runtime owns no UI for it
 * (mirrors `useRunnerEnsureHost`). Resolves to a no-op on shells without a
 * local CLI (`traycerCli === null`: mobile, web, tests).
 */
export function useRunnerCliLogin(): UseMutationResult<
  void,
  Error,
  CliLoginVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, CliLoginVariables>({
    mutationKey: runnerMutationKeys.traycerCliLogin(),
    mutationFn: async ({ token, refreshToken }) => {
      if (traycerCli === null) return;
      await traycerCli.cliLogin(token, refreshToken);
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
      });
    },
  });
}
