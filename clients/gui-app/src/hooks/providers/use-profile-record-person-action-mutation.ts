import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  PROFILE_RECORD_FAILURE_COPY,
  type ProfileRecordActionSuccess,
} from "@traycer-clients/shared/host-client/profile-record-actions";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useAuthService, useHostClient } from "@/lib/host";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { PROVIDER_INVALIDATIONS } from "./invalidations";
import { useProfileRecordEnvironmentId } from "./use-profile-record-environment-id";

interface ProfileRecordPersonActionRequest {
  readonly providerId: ProviderId;
  readonly profileId: string;
}

export function useProfileRecordPersonAction(
  action: "sign-out" | "remove",
  enabled: boolean,
): UseMutationResult<
  ProfileRecordActionSuccess,
  Error,
  ProfileRecordPersonActionRequest,
  { readonly hostId: string | null }
> {
  const auth = useAuthService();
  const client = useHostClient();
  const queryClient = useQueryClient();
  const hostId = useRequesterHostId(client);
  const environmentId = useProfileRecordEnvironmentId(client, enabled);
  const fallback = PROFILE_RECORD_FAILURE_COPY.action[action];
  return useMutation({
    mutationKey: providersMutationKeys.profileRecordAction(action, hostId),
    mutationFn: async (request: ProfileRecordPersonActionRequest) => {
      if (environmentId === null) throw new Error(fallback);
      const result =
        action === "sign-out"
          ? await auth.signOutProfileRecord(
              environmentId,
              request.providerId,
              request.profileId,
              null,
            )
          : await auth.removeProfileRecord(
              environmentId,
              request.providerId,
              request.profileId,
              null,
            );
      if (result.kind !== "ok") throw new Error(result.message);
      return result;
    },
    onMutate: () => ({ hostId: client.getActiveHostId() }),
    onSuccess: (_data, _request, context) => {
      if (context.hostId === null) return;
      for (const method of PROVIDER_INVALIDATIONS) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, method),
        });
      }
    },
    onError: (error) => toastFromAuthError(error, fallback),
  });
}
