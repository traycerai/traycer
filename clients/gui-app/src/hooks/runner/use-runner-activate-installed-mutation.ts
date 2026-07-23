import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  ActivateInstalledOk,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

export interface ActivateInstalledVariables {
  // `true` = the Force continuation after a busy `applyStaged`/`installVersion`
  // outcome carrying `continuation: "activate"` (post-commit, packaged
  // macOS), or a direct re-submit after this intent's own busy outcome.
  readonly force: boolean;
}

/**
 * Activates an already-installed-but-not-running-activated host record via
 * `IHostManagement.activateInstalled` - clears `pendingActivation` /
 * `activationUnknown` debt. Resolves the raw `MutationOutcome` (never throws
 * for a settled outcome) so callers branch on every `kind` themselves.
 */
export function useRunnerActivateInstalled(): UseMutationResult<
  MutationOutcome<ActivateInstalledOk>,
  Error,
  ActivateInstalledVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const management = runnerHost.hostManagement;
  return useMutation<
    MutationOutcome<ActivateInstalledOk>,
    Error,
    ActivateInstalledVariables
  >({
    mutationKey: runnerMutationKeys.hostActivateInstalled(),
    mutationFn: ({ force }) => {
      if (management === null) {
        return Promise.reject(new Error("Host management unavailable"));
      }
      return management.activateInstalled(force);
    },
    onSuccess: (outcome) => {
      if (outcome.kind !== "ok" || management === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostRegistryUpdate(management),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
    },
  });
}
