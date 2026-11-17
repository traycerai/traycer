import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import {
  useEnvironmentHostLists,
  type EnvironmentHostLists,
} from "@/hooks/bots/use-environment-host-lists-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { environmentReadData } from "@/hooks/environment/environment-read-data";
import {
  usePersonalEnvironment,
  type AddressedEnvironment,
} from "@/hooks/environment/use-addressed-environment";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

const STATUS_PARAMS = {};

export interface HostOwnEnvironment extends AddressedEnvironment {
  /** A read that answered is not asked again. */
  readonly retry: () => void;
}

const PENDING: AddressedEnvironment = { environmentId: null, resolved: false };
const NONE: AddressedEnvironment = { environmentId: null, resolved: true };

/**
 * authn lists a host under one environment only. `resolved` is false while that
 * is unknown; a secrets read naming no environment fails.
 */
export function useHostOwnEnvironment(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): HostOwnEnvironment {
  const asking = enabled && client !== null && hostId !== null;
  const statusSupported = useHostMethodSupport(hostId, "environment.status");
  const status = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: STATUS_PARAMS,
    // Adds no cadence of its own: a principal changes only with a move.
    options: { enabled: asking && statusSupported === true, poll: false },
  });
  const principal = status.data?.principal;
  const personal = usePersonalEnvironment(
    asking && principal?.kind === "personal",
  );
  const onTeam = asking && principal?.kind === "team";
  const environments = useEnvironmentListQuery(onTeam);
  const listed = environmentReadData(environments);
  const teamIds = teamEnvironmentIds(listed);
  const hostLists = useEnvironmentHostLists(teamIds, onTeam);
  const { isError: statusFailed, refetch: refetchStatus } = status;
  const { isError: listFailed, refetch: refetchList } = environments;
  const { retryFailed: retryHostLists } = hostLists;
  const retry = useCallback(() => {
    if (statusFailed) void refetchStatus();
    if (listFailed) void refetchList();
    retryHostLists();
  }, [statusFailed, refetchStatus, listFailed, refetchList, retryHostLists]);
  if (!asking) return { ...PENDING, retry };
  const own = ownEnvironmentFrom({
    statusSupported,
    statusFailed: status.isError,
    principal,
    personal,
    listed: listed !== undefined,
    listFailed: environments.isError,
    team: teamEnvironmentHolding(
      teamIds,
      hostLists.hostsByEnvironmentId,
      hostId,
    ),
  });
  return { ...own, retry };
}

function ownEnvironmentFrom(facts: {
  readonly statusSupported: boolean | null;
  readonly statusFailed: boolean;
  readonly principal: EnvironmentStatusResponse["principal"] | undefined;
  readonly personal: AddressedEnvironment;
  readonly listed: boolean;
  readonly listFailed: boolean;
  readonly team: AddressedEnvironment;
}): AddressedEnvironment {
  if (facts.statusSupported === null) return PENDING;
  if (!facts.statusSupported || facts.statusFailed) return NONE;
  if (facts.principal === undefined) return PENDING;
  if (facts.principal === null) return NONE;
  if (facts.principal.kind === "personal") {
    return {
      environmentId: facts.personal.environmentId,
      resolved:
        facts.personal.resolved && facts.personal.environmentId !== null,
    };
  }
  if (!facts.listed) return facts.listFailed ? NONE : PENDING;
  return facts.team;
}

function teamEnvironmentIds(
  listed: EnvironmentListResponseV11 | undefined,
): readonly string[] {
  if (listed === undefined) return [];
  return listed.environments
    .filter((environment) => environment.ownerKind === "organization")
    .map((environment) => environment.environmentId);
}

function teamEnvironmentHolding(
  teamIds: readonly string[],
  hostsByEnvironmentId: EnvironmentHostLists["hostsByEnvironmentId"],
  hostId: string,
): AddressedEnvironment {
  const holding = teamIds.find((environmentId) =>
    hostsByEnvironmentId
      .get(environmentId)
      ?.some((host) => host.hostId === hostId),
  );
  if (holding !== undefined) return { environmentId: holding, resolved: true };
  // A list that failed or has not answered may hold it: not known yet.
  const unanswered = teamIds.some(
    (environmentId) => !hostsByEnvironmentId.has(environmentId),
  );
  return unanswered ? PENDING : NONE;
}
