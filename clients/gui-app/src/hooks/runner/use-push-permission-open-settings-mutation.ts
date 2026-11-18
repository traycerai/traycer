import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

export type PushPermissionOpenSettingsMutation = UseMutationResult<
  void,
  Error,
  void
>;

/**
 * Jumps to this app's notification page in the OS Settings app - the only
 * repair once the OS has remembered a refusal. The invalidation on success is
 * a cheap head start, not the mechanism: what the person does on that page
 * happens after this resolves, and the row learns about it from the host's
 * foreground-resume `onChange`.
 */
export function usePushPermissionOpenSettingsMutation(): PushPermissionOpenSettingsMutation {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();
  return useMutation<void>({
    mutationKey: runnerMutationKeys.pushPermissionOpenSettings(),
    mutationFn: () => {
      if (pushPermission === null) {
        throw new Error("This phone has no OS notification page to open.");
      }
      return pushPermission.openSettings();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushPermission(),
      });
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't open system Settings"),
  });
}
