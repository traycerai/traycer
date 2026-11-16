import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloudMutation } from "@/hooks/environment/use-environment-cloud";
import { environmentMutationKeys } from "@/lib/query-keys";

/** Every save addresses the row revision the editor read, including creates. */
export function useConfigurationItemMutations() {
  const queries = useQueryClient();
  // Every page projection of this configuration, on every scope that read it,
  // and no other configuration. A conflict rereads the current value just as a
  // successful save does; a `forbidden` answer rereads the reader's role,
  // which `environment.list` carries and this invalidation includes.
  const reread = (environmentId: string): void => {
    invalidateConfigurationReads(queries, environmentId, [
      "environment.configuration.items",
    ]);
  };
  // A write the person did not press now (a row's unmount) is armed with the
  // sign-in its text was typed on, and the next put or delete takes it.
  const origin = useRef<EnvironmentCloud | null>(null);
  const takeOrigin = (): EnvironmentCloud | null => {
    const armed = origin.current;
    origin.current = null;
    return armed;
  };
  const put = useEnvironmentCloudMutation({
    method: "environment.configuration.items.put",
    mutationKey: environmentMutationKeys.configurationItemsPut(),
    errorMessage: "Couldn't save these settings.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
    takeOrigin,
  });
  const remove = useEnvironmentCloudMutation({
    method: "environment.configuration.items.delete",
    mutationKey: environmentMutationKeys.configurationItemsDelete(),
    errorMessage: "Couldn't remove these settings.",
    invalidateMethods: [],
    onSuccess: (_result, request) => reread(request.environmentId),
    takeOrigin,
  });
  const armOrigin = (cloud: EnvironmentCloud | null): void => {
    origin.current = cloud;
  };
  return { put, remove, armOrigin };
}
