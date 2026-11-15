import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { profileUsesRecord } from "@/components/providers/provider-profile-model";
import { useAuthService, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { providersMutationKeys } from "@/lib/query-keys";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useCachedProviderProfilesReader } from "./use-cached-providers-list";
import { useProfileRecordEnvironmentId } from "./use-profile-record-environment-id";
import {
  useRecolorProviderProfileForClient,
  type RecolorProviderProfileRequest,
} from "./use-recolor-provider-profile-mutation";

/** Settings writes a record's colour on the person's session; local rows keep their call. */
export function useAccountProfileRecolorForClient(
  client: HostClient<HostRpcRegistry> | null,
  providerId: RecolorProviderProfileRequest["providerId"],
  profile: ProviderProfile,
) {
  const local = useRecolorProviderProfileForClient(client);
  const auth = useAuthService();
  const hostId = useRequesterHostId(client);
  const pinnedClient = useMemo(
    () =>
      hostId === null || client === null
        ? null
        : resolveNamedHostClient({ hostClient: client }, hostId),
    [client, hostId],
  );
  const usesRecord = profileUsesRecord(profile);
  const environmentId = useProfileRecordEnvironmentId(client, usesRecord);
  const reader = useCachedProviderProfilesReader(pinnedClient, providerId);
  const record = useMutation<void, Error, RecolorProviderProfileRequest>({
    mutationKey: providersMutationKeys.recolorProfile(),
    retry: false,
    mutationFn: async (variables) => {
      const context = pinnedClient?.getRequestContext();
      if (
        environmentId === null ||
        context === null ||
        context === undefined ||
        context.abortSignal.aborted
      ) {
        throw new Error("Couldn't recolor profile.");
      }
      const result = await auth.setProfileRecordColor(
        environmentId,
        providerIdToGuiHarnessId(variables.providerId),
        { profileId: variables.profileId, color: variables.accentColor },
        context.abortSignal,
      );
      await reader.rereadList();
      if (result.kind === "forbidden")
        throw new Error("You don't have permission to do that.");
      if (result.kind === "conflict")
        throw new Error("This connection changed. Refresh and try again.");
      if (result.kind === "failed")
        throw new Error("Couldn't recolor profile.");
    },
  });
  return usesRecord ? record : local;
}
