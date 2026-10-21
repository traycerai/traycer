import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useOptionalHostClient } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Whether `ownerUserId` is one of the viewer's TEAM environments, read off an
 * `environment.list` answer. `false` for a person, the viewer's personal
 * environment, an unresolved owner and a list not answered yet.
 */
export function isTeamEnvironmentOwner(
  environments: EnvironmentListResponse | undefined,
  ownerUserId: string | null,
): boolean {
  if (environments === undefined || ownerUserId === null) return false;
  return environments.environments.some(
    (environment) =>
      environment.ownerKind === "organization" &&
      environment.environmentId === ownerUserId,
  );
}

/**
 * Whether a chat's owner is one of the viewer's team environments: a team
 * sandbox's environment-owned chat, whose copy must not say it belongs to
 * another collaborator.
 *
 * The same team list `EnvironmentArmScopeMount` publishes its arms from, and
 * only in a build with a server pool, where team environments exist. The
 * client is optional so a tile under test with no host runtime reads `false`.
 */
export function useIsTeamEnvironmentOwner(ownerUserId: string | null): boolean {
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const environments = useEnvironmentListQuery(
    useOptionalHostClient(),
    authorized && readProcessHostRpcTierPlan().pool !== null,
  );
  return isTeamEnvironmentOwner(environments.data, ownerUserId);
}
