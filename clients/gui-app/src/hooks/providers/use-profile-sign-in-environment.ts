import { useContext } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { usesEnvironmentSignIn } from "@traycer-clients/shared/providers/environment-profile-sign-in";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";

export type ProfileSignInEnvironment =
  | { readonly kind: "local" }
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "environment"; readonly environmentId: string };

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
  const personalEnvironment = useEnvironmentListQuery(client, personal);
  const binding = useEnvironmentHostReadQuery(client, hostId, !personal);
  if (personal) {
    if (personalEnvironment.isError)
      return {
        kind: "failed",
        retry: () => void personalEnvironment.refetch(),
      };
    if (personalEnvironment.data === undefined) return { kind: "reading" };
    const environment = personalEnvironment.data.environments.find(
      (entry) => entry.ownerKind === "user",
    );
    return environment === undefined
      ? { kind: "local" }
      : { kind: "environment", environmentId: environment.environmentId };
  }
  if (binding.isError) {
    return { kind: "failed", retry: () => void binding.refetch() };
  }
  if (binding.data === undefined) return { kind: "reading" };
  return {
    kind: "environment",
    environmentId: binding.data.environment.environmentId,
  };
}
