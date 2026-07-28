import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  ApplyStagedOk,
  ApplyStagedTrigger,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

export interface ApplyStagedVariables {
  readonly trigger: ApplyStagedTrigger;
  // `true` = re-submit after a busy outcome whose `continuation` was
  // `"retry-with-force"` (pre-commit busy). Never set for the initial click.
  readonly force: boolean;
}

/**
 * Applies the currently-staged host version via `IHostManagement.applyStaged`.
 * Resolves the raw `MutationOutcome` (never throws for a settled outcome -
 * "wait-never-reject") so callers (update banner, Settings → Host) branch on
 * every `kind` themselves: `"ok"` toasts success, `"busy"` opens the
 * Force/Defer dialog, everything else is a terminal per-intent convergence
 * failure the caller renders inline.
 */
export function useRunnerApplyStaged(): UseMutationResult<
  MutationOutcome<ApplyStagedOk>,
  Error,
  ApplyStagedVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const management = runnerHost.hostManagement;
  return useMutation<
    MutationOutcome<ApplyStagedOk>,
    Error,
    ApplyStagedVariables
  >({
    mutationKey: runnerMutationKeys.hostApplyStaged(),
    mutationFn: ({ trigger, force }) => {
      if (management === null) {
        return Promise.reject(new Error("Host management unavailable"));
      }
      return management.applyStaged(trigger, force);
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
