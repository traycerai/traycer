import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import {
  readManagedProfileBinding,
  type ManagedProfileBinding,
} from "@traycer-clients/shared/environment/configuration-settings";
import { SETTINGS_REFUSED_MESSAGE } from "@traycer-clients/shared/environment/environment-cloud";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { spendScopeKeysEqual } from "@traycer/protocol/host/provider-profile-inheritance";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  beginEnvironmentCloudOperation,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";

/** The authn connection an unmapped brokered row's sign-out disconnects. */
export interface BrokeredProfileConnection {
  readonly environmentId: string;
  readonly environmentProfileId: string;
  readonly providerId: ProviderId;
  readonly credentialIdentity: ProviderProfile["credentialIdentity"];
}

/**
 * The connection of a brokered row that is admitted in an environment and is
 * not a record (no aliases), or null for every other row.
 */
export function brokeredProfileConnection(
  providerId: ProviderId,
  profile: ProviderProfile,
): BrokeredProfileConnection | null {
  const home = profile.credentialHome;
  const environmentPresence = home?.environmentPresence;
  const environmentProfileId = profile.environmentProfileId ?? null;
  if (
    profile.aliases !== undefined ||
    home?.custodyClass !== "brokered" ||
    profile.presence?.kind !== "admitted" ||
    environmentPresence?.scope !== "environment" ||
    environmentProfileId === null
  )
    return null;
  return {
    environmentId: environmentPresence.environmentId,
    environmentProfileId,
    providerId,
    credentialIdentity: profile.credentialIdentity,
  };
}

/**
 * Whether the row's account is the one the environment's entry is bound to.
 * A Claude setup token carries no account, so it disconnects the entry it
 * names when that entry holds no account either.
 */
function bindsRowAccount(
  connection: BrokeredProfileConnection,
  binding: ManagedProfileBinding,
): boolean {
  const identity = connection.credentialIdentity;
  const key = binding.spendScopeKey;
  if (identity?.kind === "spend-scoped")
    return key !== null && spendScopeKeysEqual(identity.spendScopeKey, key);
  if (identity?.kind === "accountless") return key === null;
  return (
    connection.providerId === "claude-code" &&
    identity?.kind === "unidentified" &&
    key === null
  );
}

const UNLINK_METHOD = "environment.plans.unlink";

/** A refused disconnect, as the app reads authn's refused settings call. */
function refusedDisconnect(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: SETTINGS_REFUSED_MESSAGE,
    requestId: "",
    method: UNLINK_METHOD,
    fatalDetails: null,
  });
}

/** The sign-out refusal a host gave when the row's account moved. */
function bindingChanged(): HostRpcError {
  return new HostRpcError({
    code: "binding-changed",
    message: SETTINGS_REFUSED_MESSAGE,
    requestId: "",
    method: "providers.signOutProfile",
    fatalDetails: null,
  });
}

/**
 * Disconnects the row's connection at authn on the person's own sign-in, at
 * the entry's own binding version (the row's presence counter is this
 * computer's). An entry with no live connection is already disconnected; an
 * entry bound to another account, or any failure, changes nothing.
 */
export function useDisconnectBrokeredProfile(): UseMutationResult<
  void,
  HostRpcError,
  BrokeredProfileConnection
> {
  const source = useEnvironmentCloud();
  return useMutation<void, HostRpcError, BrokeredProfileConnection>({
    mutationFn: async (connection) => {
      const cloud = source === null ? null : source();
      const binding = await withHostQueryErrorBoundary(
        UNLINK_METHOD,
        async () => {
          cloudVerdictPreflight(UNLINK_METHOD)();
          if (cloud === null) throw hostClientUnavailableError(UNLINK_METHOD);
          try {
            return await readManagedProfileBinding(
              cloud,
              connection.environmentId,
              providerIdToGuiHarnessId(connection.providerId),
              connection.environmentProfileId,
            );
          } catch (error) {
            throw environmentCloudHostError(UNLINK_METHOD, error);
          }
        },
      );
      if (binding === null) return;
      if (!bindsRowAccount(connection, binding)) throw bindingChanged();
      if (typeof binding.bindingVersion !== "number") throw refusedDisconnect();
      const send = beginEnvironmentCloudOperation(
        cloud === null ? null : () => cloud,
      );
      const answer = await send(UNLINK_METHOD, {
        environmentId: connection.environmentId,
        profileId: connection.environmentProfileId,
        expectedBindingVersion: binding.bindingVersion,
      });
      if (answer.outcome === "forbidden") throw refusedDisconnect();
    },
    onError: (error) => toastFromHostError(error, "Couldn't sign out."),
  });
}
