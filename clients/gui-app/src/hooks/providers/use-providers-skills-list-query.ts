import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import {
  mapProvidersListToSkills,
  type SkillsListData,
} from "@/hooks/providers/native-response-map";
import { nativeSkillsListParams } from "@/lib/query-keys/providers-native-query-keys";

export function useProvidersSkillsList(args: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly enabled: boolean;
}): UseQueryResult<SkillsListData, HostRpcError> {
  const client = useHostClient();
  const listParams = {
    providerId: args.providerId,
    scope: args.scope,
    workspaceRoot: args.workspaceRoot,
  };
  return useHostQueryWithResponseMap<
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
    },
  });
}
