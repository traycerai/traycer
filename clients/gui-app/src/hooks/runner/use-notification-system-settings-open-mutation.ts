import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

export type NotificationSystemSettingsOpenMutation = UseMutationResult<
  void,
  Error,
  void
>;

export function useNotificationSystemSettingsOpenMutation(): NotificationSystemSettingsOpenMutation {
  const systemSettings = useRunnerHost().notifications.systemSettings;
  return useMutation<void>({
    mutationKey: runnerMutationKeys.notificationSystemSettingsOpen(),
    mutationFn: () => {
      if (systemSettings === null) {
        throw new Error("This platform has no notification settings page.");
      }
      return systemSettings.open();
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't open system Settings"),
  });
}
