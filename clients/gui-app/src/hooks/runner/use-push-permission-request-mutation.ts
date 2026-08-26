import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { PushPermissionState } from "@traycer-clients/shared/platform/runner-host";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

export type PushPermissionRequestMutation = UseMutationResult<
  PushPermissionState,
  Error,
  void
>;

/**
 * Raises the OS push prompt, if the OS still allows one. The resolved state is
 * NOT written into the cache: `request()` also registers the device token on a
 * grant, and the host fires `onChange` for that same edge, so the row settles
 * on a fresh `get()` either way - one source of truth for what the OS thinks,
 * rather than two that can disagree.
 */
export function usePushPermissionRequestMutation(): PushPermissionRequestMutation {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();
  return useMutation<PushPermissionState>({
    mutationKey: runnerMutationKeys.pushPermissionRequest(),
    mutationFn: () => {
      if (pushPermission === null) {
        throw new Error("This phone has no OS push permission to ask for.");
      }
      return pushPermission.request();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushPermission(),
      });
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't ask for notification permission"),
  });
}
