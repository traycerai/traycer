import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  ProviderId,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAuthService } from "@/lib/host";
import { authQueryKeys, environmentMutationKeys } from "@/lib/query-keys";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

export function useTeamProfileColor(
  onOutcome: (result: EnvironmentConfigurationItemWriteResponse) => void,
) {
  const auth = useAuthService();
  const queries = useQueryClient();
  const viewerId = useCloudChatViewerId();
  const write = useMutation({
    mutationKey: environmentMutationKeys.providersSetColor(),
    retry: false,
    mutationFn: (request: {
      readonly environmentId: string;
      readonly providerId: ProviderId;
      readonly profileId: string;
      readonly color: ProviderProfileAccentColor;
    }) =>
      auth.setProfileRecordColor(
        request.environmentId,
        providerIdToGuiHarnessId(request.providerId),
        { profileId: request.profileId, color: request.color },
        null,
      ),
    onSettled: (_data, _error, request) =>
      queries.invalidateQueries({
        queryKey: authQueryKeys.environmentProfileRecords(
          request.environmentId,
          viewerId,
        ),
      }),
  });
  return {
    pending: write.isPending,
    save: async (
      environmentId: string,
      providerId: ProviderId,
      profileId: string,
      color: ProviderProfileAccentColor,
    ): Promise<boolean> => {
      try {
        const result = await write.mutateAsync({
          environmentId,
          providerId,
          profileId,
          color,
        });
        if (result.kind === "failed") {
          toast.error("Couldn't save these settings.");
          return false;
        }
        if (result.kind === "ok")
          onOutcome({ outcome: "saved", revision: null });
        else if (result.kind === "forbidden")
          onOutcome({ outcome: "forbidden" });
        else onOutcome({ outcome: "conflict", current: null });
        return result.kind === "ok";
      } catch {
        toast.error("Couldn't save these settings.");
        return false;
      }
    },
  };
}
