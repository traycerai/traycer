import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentConfigurationSkillSearchResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/** The shortest query the directory is searched for. */
export const SKILLS_DIRECTORY_MIN_QUERY = 2;

/**
 * The public skills directory searched for `query` on the viewing host
 * (`client`), which reads it for the page. Only the query text is sent, and
 * an answer is kept only while it is shown.
 */
export function useSkillsDirectorySearchQuery(
  client: HostClient<HostRpcRegistry> | null,
  query: string,
): UseQueryResult<EnvironmentConfigurationSkillSearchResponse, HostRpcError> {
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.configuration.skills.search",
    params: { query, owner: null },
    options: {
      enabled: client !== null && query.length >= SKILLS_DIRECTORY_MIN_QUERY,
      gcTime: 0,
    },
  });
}
