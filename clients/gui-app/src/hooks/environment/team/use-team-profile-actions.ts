import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClient } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

export function useTeamProfileActions(reread: () => Promise<unknown>) {
  const client = usePoolTierHostClient(useHostClient());
  const signOut = useHostScopedMutationForClient(client, {
    method: "environment.providers.signOutProfile",
    mutationKey: environmentMutationKeys.providersSignOut(),
    errorMessage: "Couldn't sign out.",
    invalidateMethods: ["environment.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.providers.signOutProfile")();
      return Promise.resolve(request);
    },
    onSettled: () => {
      void reread();
    },
  });
  const remove = useHostScopedMutationForClient(client, {
    method: "environment.providers.removeProfile",
    mutationKey: environmentMutationKeys.providersRemove(),
    errorMessage: "Couldn't remove profile.",
    invalidateMethods: ["environment.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.providers.removeProfile")();
      return Promise.resolve(request);
    },
    onSettled: () => {
      void reread();
    },
  });
  const rename = useHostScopedMutationForClient(client, {
    method: "environment.providers.renameProfile",
    mutationKey: environmentMutationKeys.providersRename(),
    errorMessage: "Couldn't rename profile.",
    invalidateMethods: ["environment.list"],
    prepareRequest: (request) => {
      cloudVerdictPreflight("environment.providers.renameProfile")();
      return Promise.resolve(request);
    },
    onSettled: () => {
      void reread();
    },
  });
  return { signOut, remove, rename };
}
