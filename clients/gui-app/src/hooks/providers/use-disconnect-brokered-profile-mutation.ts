import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { SETTINGS_REFUSED_MESSAGE } from "@traycer-clients/shared/environment/environment-cloud";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { useEnvironmentCloudOperation } from "@/hooks/environment/use-environment-cloud";
import { toastFromHostError } from "@/lib/host-error-toast";

/** The authn connection an unmapped brokered row's sign-out disconnects. */
export interface BrokeredProfileConnection {
  readonly environmentId: string;
  readonly environmentProfileId: string;
  readonly admittedBindingVersion: number;
  /** A Claude setup token carries no account: its live connection names the version. */
  readonly setupToken: boolean;
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
    admittedBindingVersion: profile.presence.bindingVersion,
    setupToken:
      providerId === "claude-code" &&
      profile.credentialIdentity?.kind === "unidentified",
  };
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
 * Disconnects the row's connection at authn on the person's own sign-in. An
 * absent connection is already disconnected; a failure changes nothing.
 */
export function useDisconnectBrokeredProfile(): UseMutationResult<
  void,
  HostRpcError,
  BrokeredProfileConnection
> {
  const begin = useEnvironmentCloudOperation();
  return useMutation<void, HostRpcError, BrokeredProfileConnection>({
    mutationFn: async (connection) => {
      const send = begin();
      let expectedBindingVersion: number | null =
        connection.admittedBindingVersion;
      if (connection.setupToken) {
        const { plans } = await send("environment.plans.list", {
          environmentId: connection.environmentId,
        });
        const plan = plans.find(
          (candidate) =>
            candidate.profileId === connection.environmentProfileId &&
            candidate.harness === "claude",
        );
        if (plan === undefined) return;
        expectedBindingVersion = plan.bindingVersion ?? null;
        if (expectedBindingVersion === null) throw refusedDisconnect();
      }
      const answer = await send(UNLINK_METHOD, {
        environmentId: connection.environmentId,
        profileId: connection.environmentProfileId,
        expectedBindingVersion,
      });
      if (answer.outcome === "forbidden") throw refusedDisconnect();
    },
    onError: (error) => toastFromHostError(error, "Couldn't sign out."),
  });
}
