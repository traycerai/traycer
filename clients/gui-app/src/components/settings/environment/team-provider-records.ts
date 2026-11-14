import { createContext, useContext, useCallback } from "react";
import type { EnvironmentProvidersListResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { listOffersSignIns } from "@/components/providers/provider-profile-model";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { environmentReadData } from "@/hooks/environment/environment-read-data";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { TeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useHostClient } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useConfigurationSource } from "./configuration-source";

export interface TeamProviderRecords {
  readonly providers: EnvironmentProvidersListResponse["providers"];
  readonly readFailed: boolean;
  readonly reread: () => Promise<
    EnvironmentProvidersListResponse["providers"] | null
  >;
}

export const TeamProviderRecordsContext =
  createContext<TeamProviderRecords | null>(null);

export function useTeamProviderRecords(): TeamProviderRecords | null {
  return useContext(TeamProviderRecordsContext);
}

/** Only membership of this environment's host inventory permits using a
 * computer's own list. An unrelated computer's Personal rows never enter it. */
export function useTeamProviderRecordsRead(
  scope: TeamViewingHost,
): TeamProviderRecords | null {
  const source = useConfigurationSource();
  const teamPage = source.kind === "pool" && source.configuration === "team";
  const client = useHostClient();
  const hostId = useRequesterHostId(client);
  const ownEnvironment =
    teamPage &&
    hostId !== null &&
    environmentReadData(scope.hosts)?.hosts.some(
      (host) => host.hostId === hostId,
    ) === true;
  const ownList = useProvidersListForClient(client, {
    enabled: ownEnvironment,
    subscribed: ownEnvironment,
  });
  const cloud = usePoolTierHostClient(client);
  const supported = useHostSupportsMethod(
    useRequesterHostId(cloud),
    "environment.providers.list",
  );
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const list = useHostQuery({
    cacheKeyIdentity: [viewerId],
    client: cloud,
    method: "environment.providers.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight("environment.providers.list"),
    options: {
      poll: true,
      enabled:
        teamPage &&
        !ownEnvironment &&
        supported &&
        authorized &&
        viewerId.length > 0,
    },
  });
  const refetchOwn = ownList.refetch;
  const refetchTeam = list.refetch;
  const rereadOwn = useCallback(async () => {
    const answer = await refetchOwn();
    return answer.isError
      ? null
      : (answer.data?.providers.flatMap((provider) =>
          provider.profiles.length === 0
            ? []
            : [
                {
                  providerId: provider.providerId,
                  profiles: provider.profiles,
                },
              ],
        ) ?? []);
  }, [refetchOwn]);
  const rereadTeam = useCallback(async () => {
    const answer = await refetchTeam();
    return answer.isError ? null : (answer.data?.providers ?? []);
  }, [refetchTeam]);
  if (!teamPage) return null;
  if (ownEnvironment) {
    if (!listOffersSignIns(ownList.data)) return null;
    return {
      providers:
        ownList.data?.providers.flatMap((provider) =>
          provider.profiles.length === 0
            ? []
            : [
                {
                  providerId: provider.providerId,
                  profiles: provider.profiles,
                },
              ],
        ) ?? [],
      readFailed: ownList.isError,
      reread: rereadOwn,
    };
  }
  const teamList = environmentReadData(list);
  if (teamList?.profileSyncEnabled !== true) return null;
  return {
    providers: teamList.providers,
    readFailed: list.isError,
    reread: rereadTeam,
  };
}
