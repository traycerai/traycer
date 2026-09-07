import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { TraycerUninstallResult } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/** In-app "Remove Traycer" (Settings → General → Danger Zone). */
export function useRunnerUninstallTraycer(): UseMutationResult<
  TraycerUninstallResult,
  Error,
  void
> {
  const { hostManagement } = useRunnerHost();
  return useMutation<TraycerUninstallResult>({
    mutationKey: runnerMutationKeys.uninstallTraycer(),
    mutationFn: () => {
      if (hostManagement === null) {
        return Promise.reject(
          new Error("Removing Traycer is not available on this platform."),
        );
      }
      return hostManagement.uninstallTraycer();
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't remove Traycer's components."),
  });
}
