import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  InstallVersionOk,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

export interface InstallVersionVariables {
  readonly pin: string;
  // `true` = the Force continuation after this intent's own busy outcome
  // (always `continuation: "retry-with-force"` - pre-commit pin busy).
  readonly force: boolean;
}

/**
 * Pins an explicit host version (incl. downgrades) via
 * `IHostManagement.installVersion`, bypassing the staged update. Resolves
 * the raw `MutationOutcome` (never throws for a settled outcome) so Settings
 * → Host branches on every `kind` itself: `"ok"` toasts success, `"busy"`
 * opens the Force/Defer dialog, everything else is a terminal per-intent
 * convergence failure rendered inline (incl. exhausted lock-retry).
 */
export function useRunnerInstallVersion(): UseMutationResult<
  MutationOutcome<InstallVersionOk>,
  Error,
  InstallVersionVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const management = runnerHost.hostManagement;
  return useMutation<
    MutationOutcome<InstallVersionOk>,
    Error,
    InstallVersionVariables
  >({
    mutationKey: runnerMutationKeys.hostInstallVersion(),
    mutationFn: ({ pin, force }) => {
      if (management === null) {
        return Promise.reject(new Error("Host management unavailable"));
      }
      return management.installVersion(pin, force);
    },
    onSuccess: (outcome) => {
      if (outcome.kind !== "ok" || management === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostRegistryUpdate(management),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostAvailableVersionsScope(management),
      });
    },
  });
}
