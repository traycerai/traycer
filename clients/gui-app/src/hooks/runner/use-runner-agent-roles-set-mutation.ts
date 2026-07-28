import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getFeatureSettingsBridge,
  type FeatureSettingsSnapshot,
} from "@/lib/desktop-feature-settings";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

export function useRunnerAgentRolesSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: runnerMutationKeys.agentRolesEnabledSet(),
    mutationFn: (enabled: boolean) => {
      const bridge = getFeatureSettingsBridge();
      if (bridge === null) {
        throw new Error(
          "Feature settings are only available in the desktop app.",
        );
      }
      return bridge.setAgentRolesEnabled(enabled);
    },
    onSuccess: (snapshot: FeatureSettingsSnapshot) => {
      queryClient.setQueryData(runnerQueryKeys.featureSettings(), snapshot);
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't update agent roles"),
  });
}
