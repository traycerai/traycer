import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  HostEnsureResult,
  HostProgressEvent,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

export interface EnsureHostVariables {
  readonly onProgress: ((event: HostProgressEvent) => void) | null;
  // `true` = the user's "Force restart" (skip the busy check and restart a
  // running host unconditionally). Normal provisioning and "Retry restart"
  // pass `false`.
  readonly force: boolean;
}

/**
 * Post-auth host provisioning. Delegates the whole lifecycle to the CLI
 * via `IRunnerHost.hostManagement.ensureHost` (the desktop never
 * registers services or calls launchctl). Silent on error - the
 * local-host gate renders the failure surface (with a Retry that re-fires
 * this mutation), not a toast.
 */
export function useRunnerEnsureHost(): UseMutationResult<
  HostEnsureResult,
  Error,
  EnsureHostVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const { hostManagement, traycerCli } = runnerHost;
  return useMutation<HostEnsureResult, Error, EnsureHostVariables>({
    mutationKey: runnerMutationKeys.hostEnsure(),
    mutationFn: ({ onProgress, force }) => {
      if (hostManagement === null) {
        return Promise.reject(
          new Error("Host provisioning is not available on this platform."),
        );
      }
      return hostManagement.ensureHost({ onProgress, force });
    },
    onSuccess: () => {
      if (traycerCli !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
        });
      }
      if (hostManagement !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostInstalledRecord(hostManagement),
        });
      }
    },
  });
}
