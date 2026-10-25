import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * The environment an `environment.*` call names. `null` names the host's own,
 * which a host that has not moved its settings cannot answer for, so Personal
 * is named by its own id.
 */
export interface AddressedEnvironment {
  readonly environmentId: string | null;
  /** False while Personal's id is still being read; a read waits for it. */
  readonly resolved: boolean;
}

const HOST_OWN: AddressedEnvironment = { environmentId: null, resolved: true };
const PENDING: AddressedEnvironment = { environmentId: null, resolved: false };

/**
 * Personal's id, from `environment.list` (`ownerKind: "user"`). A list that
 * failed, or holds no Personal, names the host's own.
 */
export function usePersonalEnvironment(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): AddressedEnvironment {
  const environments = useEnvironmentListQuery(client, enabled);
  if (!enabled || environments.isError) return HOST_OWN;
  if (environments.data === undefined) return PENDING;
  const personal = environments.data.environments.find(
    (environment) => environment.ownerKind === "user",
  );
  return personal === undefined
    ? HOST_OWN
    : { environmentId: personal.environmentId, resolved: true };
}

/**
 * What a Settings page's `environment.*` calls name: a team's id on its
 * pages, Personal's id on the Personal pick, and the host's own on a Local
 * pick.
 */
export function useAddressedEnvironment(): AddressedEnvironment {
  const source = useConfigurationSource();
  const pick = useEnvironmentPick();
  const onPersonal = source.kind === "host" && pick.kind === "personal";
  const personal = usePersonalEnvironment(useHostClient(), onPersonal);
  if (source.kind === "pool") {
    return { environmentId: source.environmentId, resolved: true };
  }
  return personal;
}
