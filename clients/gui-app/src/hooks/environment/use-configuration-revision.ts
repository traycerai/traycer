import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import {
  CONFIGURATION_ITEM_READS,
  invalidateConfigurationReads,
} from "./environment-host-list-key";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import type { HostRpcRegistry } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * One authoritative apply position for the configuration, including one with
 * zero hosts. Never infer it from a chosen host, max(item.revision), or an
 * empty inventory: delivery can lag, and deleting the newest/final item must
 * still move this position. Receipt and room state have independent readers.
 */
export function useConfigurationRevision(
  input: HostClient<HostRpcRegistry>,
  environmentId: string | null,
): void {
  const client = usePoolTierHostClient(input);
  const { hostId } = useReactiveHostReadiness(client);
  const supported = useHostMethodSupport(
    hostId,
    "environment.configuration.revision",
  );
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const queries = useQueryClient();
  const revision = useHostQuery({
    client,
    cacheKeyIdentity: [viewerId],
    method: "environment.configuration.revision",
    params: { environmentId: environmentId ?? "" },
    preflight: cloudVerdictPreflight("environment.configuration.revision"),
    options: {
      enabled:
        supported === true &&
        environmentId !== null &&
        viewerId.length > 0 &&
        authorized,
      poll: true,
    },
  });
  const position = revision.data?.revision ?? null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (environmentId === null || position === null) return;
    const current = JSON.stringify([viewerId, hostId, environmentId, position]);
    if (seen.current === current) return;
    seen.current = current;
    // The first position closes a read that raced this mount's first item read.
    invalidateConfigurationReads(
      queries,
      environmentId,
      CONFIGURATION_ITEM_READS,
    );
  }, [environmentId, hostId, position, queries, viewerId]);
}
