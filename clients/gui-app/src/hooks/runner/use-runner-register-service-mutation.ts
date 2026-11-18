import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { QueuedDoctorRepairResult } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

export interface RegisterServiceVariables {
  /** The local host the registration is for; main refuses a replacement. */
  readonly expectedHostId: string;
}

/**
 * Registers THIS machine's host service - `traycer host service install`,
 * Doctor's Register service, through the same identity-fenced queued dispatch
 * - from the enable actions: the update-ready row's, and the failed start's
 * beside an ensure refused on a disabled task. It is the one repair that turns
 * a Scheduled Task its owner disabled back on, which is what a waiting update
 * and a host stopped on that task both need. `declined` (a replaced host, a
 * host started in a terminal) is shown as the information it is.
 */
export function useRunnerRegisterService(): UseMutationResult<
  QueuedDoctorRepairResult,
  Error,
  RegisterServiceVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const management = runnerHost.hostManagement;
  return useMutation<QueuedDoctorRepairResult, Error, RegisterServiceVariables>(
    {
      mutationKey: runnerMutationKeys.hostRegisterService(),
      mutationFn: ({ expectedHostId }) => {
        if (management === null) {
          return Promise.reject(new Error("Host management unavailable"));
        }
        return management.runDoctorRepairQueued({
          repair: "register-service",
          expectedHostId,
        });
      },
      onSuccess: (result) => {
        if (result.kind === "declined") {
          toast.info(result.message);
          return;
        }
        toast.success("Background service enabled");
        if (management === null) return;
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostControllerStatus(management),
        });
      },
      onError: (error) => {
        toastFromRunnerError(error, "Could not enable the background service");
      },
    },
  );
}
