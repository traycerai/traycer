import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthService } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

interface TeamProfileActionRequest {
  readonly environmentId: string;
  readonly providerId: string;
  readonly profileId: string;
}

export function useTeamProfileActions(reread: () => Promise<unknown>) {
  const auth = useAuthService();
  const signOut = useMutation({
    mutationKey: environmentMutationKeys.providersSignOut(),
    retry: false,
    mutationFn: async (request: TeamProfileActionRequest) => {
      const result = await auth.signOutProfileRecord(
        request.environmentId,
        request.providerId,
        request.profileId,
        null,
      );
      if (result.kind !== "ok") throw new Error(result.message);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => reread(),
  });
  const remove = useMutation({
    mutationKey: environmentMutationKeys.providersRemove(),
    retry: false,
    mutationFn: async (request: TeamProfileActionRequest) => {
      const result = await auth.removeProfileRecord(
        request.environmentId,
        request.providerId,
        request.profileId,
        null,
      );
      if (result.kind !== "ok") throw new Error(result.message);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => reread(),
  });
  const rename = useMutation({
    mutationKey: environmentMutationKeys.providersRename(),
    retry: false,
    mutationFn: async (
      request: TeamProfileActionRequest & { readonly label: string },
    ) => {
      const result = await auth.nameProfileRecord(
        request.environmentId,
        request.providerId,
        { profileId: request.profileId, name: request.label },
        null,
      );
      if (result.kind !== "ok") throw new Error(result.message);
      return result.name;
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => reread(),
  });
  return { signOut, remove, rename };
}
