import { useEffect } from "react";
import { create } from "zustand";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentHostListResponseV11,
  EnvironmentHostRecordV11,
} from "@traycer/protocol/host/environment/contracts";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

interface ViewingHostState {
  readonly picks: Readonly<Record<string, string>>;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly pick: (key: string, viewerId: string, hostId: string) => void;
  readonly visit: (viewerId: string, hostId: string) => void;
}

/** Window-local viewing choices never activate or wake a host. */
const useViewingHosts = create<ViewingHostState>((set) => ({
  picks: {},
  recent: {},
  pick: (key, viewerId, hostId) =>
    set((state) => ({
      picks: { ...state.picks, [key]: hostId },
      recent: {
        ...state.recent,
        [viewerId]: [
          hostId,
          ...(state.recent[viewerId] ?? []).filter((id) => id !== hostId),
        ],
      },
    })),
  visit: (viewerId, hostId) =>
    set((state) => {
      if (state.recent[viewerId]?.[0] === hostId) return state;
      return {
        recent: {
          ...state.recent,
          [viewerId]: [
            hostId,
            ...(state.recent[viewerId] ?? []).filter((id) => id !== hostId),
          ],
        },
      };
    }),
}));

const NO_HOSTS: readonly EnvironmentHostRecordV11[] = [];
const NO_RECENT: readonly string[] = [];

interface TeamViewingHost {
  readonly hosts: UseQueryResult<EnvironmentHostListResponseV11, HostRpcError>;
  readonly viewingHost: EnvironmentHostRecordV11 | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly selectHost: (hostId: string) => void;
  readonly canSelectHost: (hostId: string) => boolean;
}

/**
 * The team's host inventory is read through the surface's own host, which
 * forwards it on the viewer's session (the server pool does not serve it).
 * Live facts and room files share the explicit team host picked from it, or
 * no host; neither can fall through to Personal.
 */
export function useTeamViewingHost(): TeamViewingHost {
  const source = useConfigurationSource();
  const surfaceClient = useHostClient();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const environmentId = source.kind === "pool" ? source.environmentId : "";
  const hosts = useHostQuery({
    cacheKeyIdentity: [viewerId],
    client: surfaceClient,
    method: "environment.host.list",
    params: { environmentId },
    preflight: cloudVerdictPreflight("environment.host.list"),
    options: {
      enabled: source.kind === "pool" && viewerId.length > 0 && authorized,
    },
  });
  const key = JSON.stringify([viewerId, environmentId]);
  const pickedId = useViewingHosts((state) => state.picks[key]);
  const recent = useViewingHosts(
    (state) => state.recent[viewerId] ?? NO_RECENT,
  );
  const pick = useViewingHosts((state) => state.pick);
  const visit = useViewingHosts((state) => state.visit);
  const activeHostId = useEffectiveHostId();
  const rows = hosts.isError ? NO_HOSTS : (hosts.data?.hosts ?? NO_HOSTS);
  const eligible = rows.filter(isReachable);
  const selected =
    eligible.find((host) => host.hostId === pickedId) ??
    recent
      .flatMap((id) => eligible.filter((host) => host.hostId === id))
      .at(0) ??
    eligible.find((host) => host.hostId === activeHostId) ??
    eligible.at(0) ??
    null;
  const requester = useHostClientForHostId(selected?.hostId ?? null);

  useEffect(() => {
    if (
      activeHostId !== null &&
      rows.some((host) => host.hostId === activeHostId && isReachable(host))
    ) {
      visit(viewerId, activeHostId);
    }
  }, [rows, activeHostId, viewerId, visit]);

  return {
    hosts,
    viewingHost: selected,
    client: selected === null ? null : requester,
    canSelectHost: (hostId: string): boolean =>
      eligible.some((host) => host.hostId === hostId),
    selectHost: (hostId: string): void => {
      if (eligible.some((host) => host.hostId === hostId))
        pick(key, viewerId, hostId);
    },
  };
}

/** An older inventory cannot prove a host is eligible for a team read. */
function isReachable(host: EnvironmentHostRecordV11): boolean {
  return host.reachable;
}
