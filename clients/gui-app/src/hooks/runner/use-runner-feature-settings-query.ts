import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  getFeatureSettingsBridge,
  type FeatureSettingsSnapshot,
} from "@/lib/desktop-feature-settings";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";

export function useRunnerFeatureSettingsQuery() {
  return useQuery(
    queryOptions<FeatureSettingsSnapshot>({
      queryKey: runnerQueryKeys.featureSettings(),
      queryFn: () => {
        const bridge = getFeatureSettingsBridge();
        if (bridge === null) {
          throw new Error(
            "Feature settings are only available in the desktop app.",
          );
        }
        return bridge.get();
      },
      enabled: getFeatureSettingsBridge() !== null,
      staleTime: 30_000,
    }),
  );
}

export function useAgentRolesEnabled(): boolean {
  return useRunnerFeatureSettingsQuery().data?.agentRoles === true;
}
