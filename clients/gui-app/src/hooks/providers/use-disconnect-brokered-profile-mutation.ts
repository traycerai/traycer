import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import {
  readHarnessConnectionKind,
  readManagedProfileBinding,
  type ManagedProfileBinding,
} from "@traycer-clients/shared/environment/configuration-settings";
import {
  SETTINGS_REFUSED_MESSAGE,
  type EnvironmentCloud,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";

export interface BrokeredProfileConnection {
  readonly environmentId: string;
  readonly environmentProfileId: string;
  readonly providerId: ProviderId;
  readonly credentialIdentity: ProviderProfile["credentialIdentity"];
}

/** A row with `aliases` is a record's, which this does not disconnect. */
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

/** "setup-token" holds only while the entry's connection is a setup token. */
function rowAccountMatch(
  connection: BrokeredProfileConnection,
  binding: ManagedProfileBinding,
): "bound" | "setup-token" | "other" {
  const identity = connection.credentialIdentity;
  const key = binding.spendScopeKey;
  if (identity?.kind === "spend-scoped")
    return key !== null && spendScopeKeysEqual(identity.spendScopeKey, key)
      ? "bound"
      : "other";
  if (identity?.kind === "accountless" && key === null) return "bound";
  return connection.providerId === "claude-code" &&
    identity?.kind === "unidentified" &&
    key === null
    ? "setup-token"
    : "other";
}

const UNLINK_METHOD = "environment.plans.unlink";

function refusedDisconnect(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: SETTINGS_REFUSED_MESSAGE,
    requestId: "",
    method: UNLINK_METHOD,
    fatalDetails: null,
  });
}

/** This code and method select the existing binding-changed toast. */
function bindingChanged(): HostRpcError {
  return new HostRpcError({
    code: "binding-changed",
    message: SETTINGS_REFUSED_MESSAGE,
    requestId: "",
    method: "providers.signOutProfile",
    fatalDetails: null,
  });
}

async function assertBoundTo(
  client: HostClient<HostRpcRegistry>,
  environmentId: string,
): Promise<void> {
  const binding = await client
    .request("environment.host.read", {})
    .catch(() => null);
  if (binding === null || binding.sharingGeneration === null)
    throw refusedDisconnect();
  if (binding.environment.environmentId !== environmentId)
    throw bindingChanged();
}

function readOnSignIn<T>(
  cloud: EnvironmentCloud | null,
  read: (cloud: EnvironmentCloud) => Promise<T>,
): Promise<T> {
  return withHostQueryErrorBoundary(UNLINK_METHOD, async () => {
    cloudVerdictPreflight(UNLINK_METHOD)();
    if (cloud === null) throw hostClientUnavailableError(UNLINK_METHOD);
    try {
      return await read(cloud);
    } catch (error) {
      throw environmentCloudHostError(UNLINK_METHOD, error);
    }
  });
}

/**
 * Sends the entry's binding version, not the row's presence counter (this
 * computer's); no entry means it is already disconnected.
 */
export function useDisconnectBrokeredProfile(): UseMutationResult<
  void,
  HostRpcError,
  BrokeredProfileConnection
> {
  const source = useEnvironmentCloud();
  const client = useHostClient();
  return useMutation<void, HostRpcError, BrokeredProfileConnection>({
    mutationFn: async (connection) => {
      const assertBound = (): Promise<void> =>
        assertBoundTo(client, connection.environmentId);
      await assertBound();
      const cloud = source === null ? null : source();
      const harness = providerIdToGuiHarnessId(connection.providerId);
      const binding = await readOnSignIn(cloud, (signedIn) =>
        readManagedProfileBinding(
          signedIn,
          connection.environmentId,
          harness,
          connection.environmentProfileId,
        ),
      );
      await assertBound();
      if (binding === null) return;
      const match = rowAccountMatch(connection, binding);
      if (match === "other") throw bindingChanged();
      if (match === "setup-token") {
        const kind = await readOnSignIn(cloud, (signedIn) =>
          readHarnessConnectionKind(
            signedIn,
            connection.environmentId,
            harness,
            binding.entryProfileId,
          ),
        );
        await assertBound();
        if (kind !== "setup_token") throw bindingChanged();
      }
      if (typeof binding.bindingVersion !== "number") throw refusedDisconnect();
      const send = beginEnvironmentCloudOperation(
        cloud === null ? null : () => cloud,
      );
      const answer = await send(UNLINK_METHOD, {
        environmentId: connection.environmentId,
        profileId: binding.entryProfileId,
        expectedBindingVersion: binding.bindingVersion,
      });
      if (answer.outcome === "forbidden") throw refusedDisconnect();
    },
    onError: (error) => toastFromHostError(error, "Couldn't sign out."),
  });
}
