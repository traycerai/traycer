import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  profileRecordActionFailure,
  type ProfileRecordActionFailure,
} from "@traycer-clients/shared/host-client/profile-record-actions";
import { useAuthService, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { providersMutationKeys } from "@/lib/query-keys";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useCachedProviderProfilesReader } from "./use-cached-providers-list";
import { useProfileRecordEnvironmentId } from "./use-profile-record-environment-id";
import type { RenameProviderProfileRequest } from "./use-rename-provider-profile-mutation";

class ProfileRecordNameError extends Error {
  readonly failure: ProfileRecordActionFailure;

  constructor(failure: ProfileRecordActionFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/** Errors stay inline in the edit and naming dialogs, using the action's refusal table. */
export function useNameProfileRecordForClient(
  client: HostClient<HostRpcRegistry> | null,
  providerId: string,
  enabled: boolean,
) {
  const auth = useAuthService();
  const hostId = useRequesterHostId(client);
  const pinnedClient = useMemo(
    () =>
      hostId === null || client === null
        ? null
        : resolveNamedHostClient({ hostClient: client }, hostId),
    [client, hostId],
  );
  const environmentId = useProfileRecordEnvironmentId(client, enabled);
  const reader = useCachedProviderProfilesReader(pinnedClient, providerId);
  return useMutation<
    string,
    ProfileRecordNameError,
    RenameProviderProfileRequest
  >({
    mutationKey: providersMutationKeys.renameProfile(),
    retry: false,
    mutationFn: async (variables) => {
      const context = pinnedClient?.getRequestContext();
      if (
        environmentId === null ||
        context === null ||
        context === undefined ||
        context.abortSignal.aborted
      ) {
        throw new ProfileRecordNameError(
          profileRecordActionFailure("name", { kind: "failed" }),
        );
      }
      const result = await auth.nameProfileRecord(
        environmentId,
        variables.providerId,
        { profileId: variables.profileId, name: variables.label },
        context.abortSignal,
      );
      await reader.rereadList();
      if (result.kind !== "ok") throw new ProfileRecordNameError(result);
      return result.name;
    },
  });
}
