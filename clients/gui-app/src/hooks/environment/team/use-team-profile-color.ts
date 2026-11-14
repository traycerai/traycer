import { z } from "zod";
import { toast } from "sonner";
import type {
  ProviderId,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useConfigurationProviderItemsQuery } from "./use-provider-items-query";
import { useConfigurationItemMutations } from "./use-configuration-item-mutations";

/** Read the current revision after sign-in or Rename, then change only color. */
export function useTeamProfileColor(
  onOutcome: (result: EnvironmentConfigurationItemWriteResponse) => void,
) {
  const items = useConfigurationProviderItemsQuery();
  const { put } = useConfigurationItemMutations();
  return {
    pending: items.isFetching || put.isPending,
    save: async (
      environmentId: string,
      providerId: ProviderId,
      profileId: string,
      color: ProviderProfileAccentColor,
    ): Promise<boolean> => {
      const fresh = await items.refetch();
      const item = fresh.data?.find(
        (row) =>
          row.kind === "managed_profile" &&
          row.key === `${providerIdToGuiHarnessId(providerId)}:${profileId}`,
      );
      if (fresh.isError || item === undefined) {
        toast.error("Couldn't save these settings.");
        return false;
      }
      const result = await put.mutateAsync({
        environmentId,
        kind: "managed_profile",
        key: item.key,
        os: null,
        value: { ...z.record(z.string(), z.json()).parse(item.value), color },
        revision: item.revision,
      });
      onOutcome(result);
      return result.outcome === "saved";
    },
  };
}
