import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEnvironmentCloudQuery } from "@/hooks/environment/use-environment-cloud";
import {
  REVISION_MOVED_READS,
  invalidateConfigurationReads,
} from "./environment-host-list-key";

/**
 * One authoritative apply position for the configuration, including one with
 * zero hosts, read by the app itself from authn. Never infer it from a chosen
 * host, max(item.revision), or an empty inventory: delivery can lag, and
 * deleting the newest/final item must still move this position. Receipt and
 * room state have independent readers.
 */
export function useConfigurationRevision(environmentId: string | null): void {
  const viewerId = useCloudChatViewerId();
  const queries = useQueryClient();
  const revision = useEnvironmentCloudQuery({
    method: "environment.configuration.revision",
    params: { environmentId: environmentId ?? "" },
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: environmentId !== null,
    poll: true,
  });
  const position = revision.data?.revision ?? null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (environmentId === null || position === null) return;
    const current = JSON.stringify([viewerId, environmentId, position]);
    if (seen.current === current) return;
    seen.current = current;
    // The first position closes a read that raced this mount's first item read.
    invalidateConfigurationReads(queries, environmentId, REVISION_MOVED_READS);
  }, [environmentId, position, queries, viewerId]);
}
