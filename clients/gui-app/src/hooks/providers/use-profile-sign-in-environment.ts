import type { UseQueryResult } from "@tanstack/react-query";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import { providersLinkV12 } from "@traycer/protocol/host/environment-contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useContext } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usesEnvironmentSignIn } from "@traycer-clients/shared/providers/environment-profile-sign-in";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import {
  useEnvironmentHostReadQuery,
  type EnvironmentHostRead,
} from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
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

/** Unknown versions cannot authorize a local sign-in before negotiation. */
export function useEnvironmentProfileSignInSupported(
  hostId: string | null,
  providerId: string,
  managed: boolean,
): boolean | null {
  const startPresent = useHostMethodSupport(hostId, "providers.link");
  const completePresent = useHostMethodSupport(
    hostId,
    "providers.linkComplete",
  );
  const startVersion = useHostMethodSchemaVersion(hostId, "providers.link");
  const completeVersion = useHostMethodSchemaVersion(
    hostId,
    "providers.linkComplete",
  );
  if (
    !managed ||
    !usesEnvironmentSignIn(providerId, providersLinkV12.schemaVersion)
  )
    return false;
  const startSupported =
    startVersion === null
      ? null
      : usesEnvironmentSignIn(providerId, startVersion);
  const completeSupported =
    completeVersion === null
      ? null
      : usesEnvironmentSignIn(providerId, completeVersion);
  if (
    startPresent === false ||
    completePresent === false ||
    startSupported === false ||
    completeSupported === false
  )
    return false;
  if (startSupported === null || completeSupported === null) return null;
  return true;
}

/** Settings Personal names Personal. A composer instead names the environment
 * bound to its captured execution host, never the Settings picker. */
export function useProfileSignInEnvironment(
  client: HostClient<HostRpcRegistry>,
): ProfileSignInEnvironment {
  const hostId = useRequesterHostId(client);
  const page = useContext(PersonalPageContext);
  const personal = page?.pick.kind === "personal";
  const statusSupported = useHostMethodSupport(hostId, "environment.status");
  const bindingSupported = useHostMethodSupport(
    hostId,
    readsHostBindingsFromPool()
      ? "environment.binding.read"
      : "environment.host.read",
  );
  const listSupported = useHostMethodSupport(hostId, "environment.list");
  const status = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: !personal && statusSupported === true },
  });
  const sharedSettings =
    !personal &&
    statusSupported === true &&
    !status.isError &&
    status.data !== undefined &&
    status.data.principal !== null;
  const binding = useEnvironmentHostReadQuery(
    client,
    hostId,
    sharedSettings && bindingSupported === true,
  );
  const boundEnvironment = boundSignInEnvironment(
    status,
    binding,
    statusSupported,
    bindingSupported,
  );
  const organization =
    boundEnvironment.kind === "environment" && namesTeam(binding);
  const environments = useEnvironmentListQuery(
    client,
    listSupported === true && (personal || organization),
  );
  if (personal)
    return listedSignInEnvironment(environments, null, listSupported);
  if (boundEnvironment.kind !== "environment") return boundEnvironment;
  if (organization)
    return listedSignInEnvironment(
      environments,
      boundEnvironment.environmentId,
      listSupported,
    );
  return boundEnvironment;
}

function namesTeam(read: EnvironmentHostRead): boolean {
  return (
    read.kind === "binding" &&
    read.query.data?.environment.ownerKind === "organization"
  );
}

function boundSignInEnvironment(
  status: UseQueryResult<EnvironmentStatusResponseV12, HostRpcError>,
  binding: EnvironmentHostRead,
  statusSupported: boolean | null,
  bindingSupported: boolean | null,
): ProfileSignInEnvironment {
  if (statusSupported === false) return { kind: "local" };
  if (statusSupported === null) return { kind: "reading" };
  if (status.isError)
    return { kind: "failed", retry: () => void status.refetch() };
  if (status.data === undefined) return { kind: "reading" };
  if (status.data.principal === null) return { kind: "local" };
  if (bindingSupported === false) return { kind: "local" };
  if (bindingSupported === null) return { kind: "reading" };
  // A computer that runs its own settings has a principal but no
  // environment: the pool would name it Personal, and the host refuses.
  if (binding.kind === "own_settings") return { kind: "local" };
  if (binding.kind === "pending") return { kind: "reading" };
  if (binding.kind === "failed")
    return { kind: "failed", retry: binding.retry };
  const query = binding.query;
  if (query.isError) {
    // Re-read the status first: a host moved to its own settings signs in
    // locally, and no binding answers before the fresh status does.
    const retry = (): void => {
      void status.refetch().then(() => query.refetch());
    };
    return { kind: "failed", retry };
  }
  if (query.data === undefined) return { kind: "reading" };
  const environmentId = query.data.environment.environmentId;
  return { kind: "environment", environmentId, canSignIn: true };
}

/** A named team's role comes from the account inventory, not the host binding. */
function listedSignInEnvironment(
  environments: UseQueryResult<EnvironmentListResponseV11, HostRpcError>,
  environmentId: string | null,
  supported: boolean | null,
): ProfileSignInEnvironment {
  if (supported === false) return { kind: "local" };
  if (supported === null) return { kind: "reading" };
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
