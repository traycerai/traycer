import { useId } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProvidersPreviewProfileMoveRequest } from "@traycer/protocol/host/profile-move-schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { providersMutationKeys } from "@/lib/query-keys";

export function useProvidersPreviewProfileMove(
  client: HostClient<HostRpcRegistry> | null,
  request: ProvidersPreviewProfileMoveRequest,
  enabled: boolean,
) {
  const previewId = useId();
  return useHostQuery<HostRpcRegistry, "providers.previewProfileMove">({
    client,
    cacheKeyIdentity: [previewId],
    method: "providers.previewProfileMove",
    requiredHostMethodVersion: () => ({
      method: "providers.previewProfileMove",
      version: { major: 1, minor: 0 },
    }),
    params: request,
    options: {
      enabled,
      staleTime: Infinity,
      gcTime: 0,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });
}

export function useProvidersCommitProfileMove(
  client: HostClient<HostRpcRegistry> | null,
) {
  return useHostScopedMutationForClient(client, {
    method: "providers.commitProfileMove",
    requiredHostMethodVersion: () => ({
      method: "providers.commitProfileMove",
      version: { major: 1, minor: 0 },
    }),
    mutationKey: providersMutationKeys.commitProfileMove(),
    errorMessage: null,
    invalidateMethods: ["agent.list"],
  });
}
