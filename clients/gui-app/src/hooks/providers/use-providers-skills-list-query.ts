import { useEffect } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  mapProvidersListToSkills,
  type SkillsListData,
} from "@/hooks/providers/native-response-map";
import { nativeSkillsListParams } from "@/lib/query-keys/providers-native-query-keys";

/** Matches this query's `staleTime`: refresh exactly when it goes stale. */
const SKILLS_LIST_REFRESH_MS = 30_000;

export function useProvidersSkillsList(args: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly enabled: boolean;
}): UseQueryResult<SkillsListData, HostRpcError> {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const listParams = {
    providerId: args.providerId,
    scope: args.scope,
    workspaceRoot: args.workspaceRoot,
  };
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.list",
    SkillsListData
  >({
    cacheKeyIdentity: ["providers", "native", "skills"],
    client,
    method: "providers.list",
    params: nativeSkillsListParams(listParams),
    mapResponse: ({ response }) => mapProvidersListToSkills({ response }),
    options: {
      enabled: args.enabled,
      staleTime: 30_000,
      // `refetchInterval` fires regardless of `staleTime`, so omitting this would re-list on the shared ~800ms cadence.
      poll: false,
    },
  });

  // Opting out of the table poll removed the last thing that refetched this.
  const { refetch } = query;
  const enabled = args.enabled;
  useEffect(() => {
    if (!enabled || !readiness.isReady) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refetch();
    }, SKILLS_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, readiness.isReady, refetch]);

  return query;
}
