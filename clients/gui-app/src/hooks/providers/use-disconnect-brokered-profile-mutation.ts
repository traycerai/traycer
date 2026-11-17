import { useEffect, useRef } from "react";
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
 * A Claude setup token carries no account: on an entry that holds none either,
 * it is the entry's only while the entry's live connection is a setup token.
 */
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

/**
 * Refuses a sign-out whose row no longer answers to the environment's entry
 * or to this computer's binding, with the code the existing copy reads.
 */
function bindingChanged(): HostRpcError {
  return new HostRpcError({
    code: "binding-changed",
    message: SETTINGS_REFUSED_MESSAGE,
    requestId: "",
    method: "providers.signOutProfile",
    fatalDetails: null,
  });
}

/** One authn read of the sign-out, on the sign-in the operation began on. */
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
 * Disconnects the row's family at authn on the person's own sign-in, at its
 * entry's binding version (the row's presence counter is this computer's).
 * Nothing changes unless this computer is bound to the row's environment
 * before and after each read, the entry holds the row's account (a setup
 * token only on a setup-token connection), and the disconnect answers. An
 * environment with no entry for the row is already disconnected.
 */
export function useDisconnectBrokeredProfile(
  boundEnvironmentId: string | null,
): UseMutationResult<void, HostRpcError, BrokeredProfileConnection> {
  const source = useEnvironmentCloud();
  const bound = useRef(boundEnvironmentId);
  useEffect(() => {
    bound.current = boundEnvironmentId;
  }, [boundEnvironmentId]);
  return useMutation<void, HostRpcError, BrokeredProfileConnection>({
    mutationFn: async (connection) => {
      const assertBound = (): void => {
        if (bound.current !== connection.environmentId) throw bindingChanged();
      };
      assertBound();
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
      assertBound();
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
        assertBound();
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
