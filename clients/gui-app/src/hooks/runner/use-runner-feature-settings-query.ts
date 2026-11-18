import { createContext, use } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  getFeatureSettingsBridge,
  type FeatureSettingsSnapshot,
} from "@/lib/desktop-feature-settings";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";

export function useRunnerFeatureSettingsQuery() {
  return useRunnerFeatureSettingsQueryWithSubscription(true);
}

/**
 * `useRunnerFeatureSettingsQuery` with the observer's subscription under the
 * caller's control. `subscribed: false` reads the cached snapshot and joins
 * nothing: for a consumer whose answer arrives from a provider higher up.
 */
function useRunnerFeatureSettingsQueryWithSubscription(subscribed: boolean) {
  return useQuery({
    ...queryOptions<FeatureSettingsSnapshot>({
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
    subscribed,
  });
}

/**
 * Whether agent roles are on, held once by a panel for every row under it.
 * `null` (the default) means no panel provides it and each consumer reads
 * the feature-settings query for itself. The sidebar tree provides it so a
 * branch of rows does not add one observer per row to a query whose answer
 * is the same for all of them.
 */
export const AgentRolesEnabledContext = createContext<boolean | null>(null);

export function useAgentRolesEnabled(): boolean {
  const provided = use(AgentRolesEnabledContext);
  const own = useRunnerFeatureSettingsQueryWithSubscription(provided === null);
  return provided === null ? own.data?.agentRoles === true : provided;
}
