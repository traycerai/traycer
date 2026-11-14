import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";
import {
  listOffersSignIns,
  profileUsesRecord,
} from "@/components/providers/provider-profile-model";
import { useAuthService, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { providersMutationKeys } from "@/lib/query-keys";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import {
  useCachedProviderProfilesReader,
  useCachedProvidersList,
} from "./use-cached-providers-list";
import { useProfileRecordEnvironmentId } from "./use-profile-record-environment-id";
import { useProvidersSetProfileEnabledForClient } from "./use-providers-set-profile-enabled-mutation";

type SetEnabledRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.setProfileEnabled"
>;

/** Settings and usage share the record edit; other consumers keep their local action. */
export function useAccountProfileSetEnabledForClient(
  client: HostClient<HostRpcRegistry> | null,
  providerId: string,
): { readonly mutate: (variables: SetEnabledRequest) => void } {
  const local = useProvidersSetProfileEnabledForClient(client, providerId);
  const auth = useAuthService();
  const hostId = useRequesterHostId(client);
  const pinnedClient = useMemo(
    () =>
      hostId === null || client === null
        ? null
        : resolveNamedHostClient({ hostClient: client }, hostId),
    [client, hostId],
  );
  const list = useCachedProvidersList(client);
  const offersSignIns = listOffersSignIns(list);
  const hasRecord =
    list?.providers.some((provider) =>
      provider.profiles.some((profile) =>
        profileUsesRecord(profile, offersSignIns),
      ),
    ) === true;
  const environmentId = useProfileRecordEnvironmentId(client, hasRecord);
  const reader = useCachedProviderProfilesReader(pinnedClient, providerId);
  const record = useMutation<void, HostRpcError, SetEnabledRequest>({
    mutationKey: providersMutationKeys.setProfileEnabled(hostId, providerId),
    retry: false,
    mutationFn: async (variables) => {
      if (environmentId === null) throw enablementError("RPC_ERROR");
      const context = pinnedClient?.getRequestContext();
      if (
        context === null ||
        context === undefined ||
        context.abortSignal.aborted ||
        !context.cloudAuthorized
      ) {
        throw enablementError("RPC_ERROR");
      }
      const harnessId =
        Object.entries(TUI_HARNESS_ID_TO_PROVIDER_ID).find(
          (entry) => entry[1] === variables.providerId,
        )?.[0] ?? variables.providerId;
      const result = await auth.setProfileRecordEnabled(
        environmentId,
        harnessId,
        variables.profileId,
        variables.enabled,
        context.abortSignal,
      );
      if (
        result.kind === "ok" ||
        result.kind === "forbidden" ||
        result.kind === "conflict"
      ) {
        await reader.rereadList();
      }
      if (result.kind === "forbidden") throw enablementError("FORBIDDEN");
      if (result.kind === "conflict") throw enablementError("binding-changed");
      if (result.kind === "failed") throw enablementError("RPC_ERROR");
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't update profile availability."),
  });
  return {
    mutate: (variables) => {
      const profile = list?.providers
        .find((provider) => provider.providerId === variables.providerId)
        ?.profiles.find((row) => row.profileId === variables.profileId);
      if (profile !== undefined && profileUsesRecord(profile, offersSignIns))
        record.mutate(variables);
      else local.mutate(variables);
    },
  };
}

function enablementError(
  code: "RPC_ERROR" | "FORBIDDEN" | "binding-changed",
): HostRpcError {
  return new HostRpcError({
    code,
    method: "providers.setProfileEnabled",
    requestId: "profile-availability",
    message: "Profile availability update failed",
    fatalDetails: null,
  });
}
