import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentProfileRecords } from "@traycer-clients/shared/host-client/profile-record-actions";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useAuthService } from "@/lib/host";
import { cloudProviderKeyKeys } from "@/lib/query-keys/cloud-provider-key-keys";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

export interface CloudProviderKeyScope {
  readonly viewerId: string;
  readonly identityGeneration: number;
  readonly environmentId: string;
  readonly canEdit: boolean;
}

export function useCloudProviderKeyScope(): CloudProviderKeyScope {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const auth = useAuthService();
  const viewerId = useAuthStore((state) => state.contextMetadata?.userId ?? "");
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return {
    viewerId,
    identityGeneration: auth.getIdentityGeneration(),
    environmentId: source.kind === "pool" ? source.environmentId : "",
    canEdit: authorized && source.kind === "pool" && canEdit,
  };
}

export function useCloudProviderApiKeyQuery(
  scope: CloudProviderKeyScope,
): UseQueryResult<EnvironmentProfileRecords, HostRpcError> {
  const auth = useAuthService();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useQuery(
    queryOptions({
      queryKey: cloudProviderKeyKeys.records(
        scope.viewerId,
        scope.identityGeneration,
        scope.environmentId,
      ),
      enabled:
        authorized && scope.viewerId !== "" && scope.environmentId !== "",
      retry: false,
      queryFn: async ({ signal }) => {
        const chosen = auth.chosenSignIn();
        if (
          chosen.userId !== scope.viewerId ||
          chosen.identityGeneration !== scope.identityGeneration
        ) {
          throw new HostRpcError({
            code: "UNAUTHORIZED",
            message: "Couldn't read the API key.",
            requestId: "",
            method: "provider-keys.read",
            fatalDetails: null,
          });
        }
        const origin = auth.environmentCloud();
        const result = await auth.readProfileRecords(
          scope.environmentId,
          signal,
        );
        if (!origin.onOriginSignIn() || result.kind !== "ok") {
          throw new HostRpcError({
            code: result.kind === "forbidden" ? "FORBIDDEN" : "RPC_ERROR",
            message: "Couldn't read the API key.",
            requestId: "",
            method: "provider-keys.read",
            fatalDetails: null,
          });
        }
        return result.list;
      },
    }),
  );
}
