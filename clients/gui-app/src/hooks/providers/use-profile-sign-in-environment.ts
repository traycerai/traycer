import type { UseQueryResult } from "@tanstack/react-query";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useContext } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usesEnvironmentSignIn } from "@traycer-clients/shared/providers/environment-profile-sign-in";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";

export type ProfileSignInEnvironment =
  | { readonly kind: "local" }
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | {
      readonly kind: "environment";
      readonly environmentId: string;
      readonly canSignIn: boolean;
    };

/** Settings Personal names Personal. A composer instead names the environment
 * bound to its captured execution host, never the Settings picker. */
export function useEnvironmentProfileSignInSupported(
  client: HostClient<HostRpcRegistry> | null,
  providerId: string,
  managed: boolean,
): boolean {
  const hostId = useRequesterHostId(client);
  const version = useHostMethodSchemaVersion(hostId, "providers.link");
  return managed && usesEnvironmentSignIn(providerId, version);
}

export function useProfileSignInEnvironment(
  client: HostClient<HostRpcRegistry>,
): ProfileSignInEnvironment {
  const hostId = useRequesterHostId(client);
  const page = useContext(PersonalPageContext);
  const personal = page?.pick.kind === "personal";
  const status = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: !personal },
  });
  const sharedSettings =
    status.data !== undefined && status.data.principal !== null;
  const binding = useEnvironmentHostReadQuery(
    client,
    hostId,
    !personal && sharedSettings,
  );
  const environments = useEnvironmentListQuery(
    client,
    personal ||
      (sharedSettings &&
        binding.data?.environment.ownerKind === "organization"),
  );
  if (personal) return listedSignInEnvironment(environments, null);
  if (status.isError)
    return { kind: "failed", retry: () => void status.refetch() };
  if (status.data === undefined) return { kind: "reading" };
  if (status.data.principal === null) return { kind: "local" };
  if (binding.isError) {
    return { kind: "failed", retry: () => void binding.refetch() };
  }
  if (binding.data === undefined) return { kind: "reading" };
  const environmentId = binding.data.environment.environmentId;
  if (binding.data.environment.ownerKind === "organization")
    return listedSignInEnvironment(environments, environmentId);
  return { kind: "environment", environmentId, canSignIn: true };
}

/** A named team's role comes from the account inventory, not the host binding. */
function listedSignInEnvironment(
  environments: UseQueryResult<EnvironmentListResponseV11, HostRpcError>,
  environmentId: string | null,
): ProfileSignInEnvironment {
  if (environments.isError)
    return { kind: "failed", retry: () => void environments.refetch() };
  if (environments.data === undefined) return { kind: "reading" };
  const target = environments.data.environments.find((entry) =>
    environmentId === null
      ? entry.ownerKind === "user"
      : entry.environmentId === environmentId,
  );
  if (target === undefined)
    return environmentId === null
      ? { kind: "local" }
      : { kind: "environment", environmentId, canSignIn: false };
  return {
    kind: "environment",
    environmentId: target.environmentId,
    canSignIn: configurationRoleOf(target) !== null,
  };
}
