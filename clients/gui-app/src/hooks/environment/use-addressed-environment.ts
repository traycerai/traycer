import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";

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

interface PersonalEnvironment extends AddressedEnvironment {
  readonly retry: () => void;
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
): PersonalEnvironment {
  const environments = useEnvironmentListQuery(client, enabled);
  const { refetch } = environments;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (!enabled || environments.isError) return { ...HOST_OWN, retry };
  if (environments.data === undefined) return { ...PENDING, retry };
  const personal = environments.data.environments.find(
    (environment) => environment.ownerKind === "user",
  );
  return personal === undefined
    ? { ...HOST_OWN, retry }
    : { environmentId: personal.environmentId, resolved: true, retry };
}

/**
 * What a Settings page's `environment.*` calls name: a team's id on its
 * pages, Personal's id on the Personal pick, and the host's own on a Local
 * pick or without environments, when no Personal exists to look up.
 */
export function useAddressedEnvironment(): AddressedEnvironment {
  const source = useConfigurationSource();
  const pick = useEnvironmentPick();
  // Unread names the host's own too: nothing is looked up until the read
  // lands on.
  const environments = usePreviewFeature("environments");
  const onPersonal =
    source.kind === "host" && pick.kind === "personal" && environments === "on";
  const personal = usePersonalEnvironment(useHostClient(), onPersonal);
  if (source.kind === "pool") {
    return { environmentId: source.environmentId, resolved: true };
  }
  return personal;
}
