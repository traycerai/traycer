import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostRestartRequestResult } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";

// Surfaces respawn failures via toast.
//
// Earlier this hook was deliberately silent on error - the assumption
// was that the local-host snapshot stream would drive the gate UI on
// its own. That holds for the legacy CLI-driven respawn path (errors
// flow through `HostLifecycle.respawn()`'s `emit("error", …)` and
// surface as macOS critical notifications),
// but the macOS host-owned-login-item respawn path
// (`app/host-respawn.ts`) THROWS instead - its actionable errors
// (e.g. `approvalRequiredMessage()` directing the user to System
// Settings → Login Items) never reach the host snapshot stream.
// Silencing those would leave the user staring at a generic "host
// unavailable" card with no path forward.
//
// `toastFromRunnerError` uses `readErrorMessage` to extract the
// message; falls back to "Couldn't restart host" when none is
// available. The local-host stream still drives the steady-state
// gate UI - toasts here only fire on hard failures the stream can't
// represent.
export function useRunnerRequestHostRespawn(): UseMutationResult<
  HostRestartRequestResult,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<HostRestartRequestResult>({
    mutationKey: runnerMutationKeys.requestHostRespawn(),
    mutationFn: () => runnerHost.requestHostRespawn(),
    onSuccess: (result) => {
      // A `declined` result resolves (rather than rejecting) because it is
      // not an error: the host deliberately was not restarted - busy work,
      // removed-by-user, lock contention - and a later retry succeeds on
      // its own; see `toastHostRestartDeclined`.
      if (result.kind === "declined") {
        toastHostRestartDeclined(result.message);
        return;
      }
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
      });
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't restart host"),
  });
}
