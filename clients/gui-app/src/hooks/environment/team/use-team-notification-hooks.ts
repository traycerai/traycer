import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { putConfigurationItem } from "@traycer-clients/shared/environment/configuration-settings";
import { notificationHooksValueSchema } from "@traycer-clients/shared/environment/notification-hook-item";
import { NOTIFICATION_HOOKS_ITEM } from "@traycer-clients/shared/environment/notification-hook-item-kind";
import {
  accountHooksForEditor,
  type CloudNotificationHook,
} from "@traycer-clients/shared/environment/notification-hook-values";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
  NEEDS_PERMISSION_MESSAGE,
} from "@traycer-clients/shared/environment/environment-cloud";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { configurationReadMatches } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { environmentMutationKeys } from "@/lib/query-keys";
import {
  useConfigurationItemsQuery,
  type ConfigurationItem,
} from "./use-configuration-items-query";

function hooksOf(items: readonly ConfigurationItem[]) {
  const item = items.find(
    (entry) =>
      entry.kind === NOTIFICATION_HOOKS_ITEM.kind &&
      entry.key === NOTIFICATION_HOOKS_ITEM.key &&
      entry.os === null,
  );
  if (item === undefined) return { hooks: [], revision: null };
  const parsed = notificationHooksValueSchema.safeParse(item.value);
  if (!parsed.success)
    throw environmentCloudHostError(
      "environment.configuration.items",
      new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE),
    );
  return { hooks: accountHooksForEditor(parsed.data), revision: item.revision };
}

interface TeamHooksWrite {
  readonly hooks: readonly CloudNotificationHook[];
  readonly revision: number | null;
}

/** One team item, using the existing item client and the sign-in's write seat. */
export function useTeamNotificationHooks() {
  const source = useConfigurationSource();
  const cloud = useEnvironmentCloud();
  const queries = useQueryClient();
  const environmentId = source.kind === "pool" ? source.environmentId : null;
  const canEdit =
    source.kind === "pool" &&
    source.configuration === "team" &&
    (source.effectiveRole === "admin" || source.effectiveRole === "editor");
  const read = useConfigurationItemsQuery(
    NOTIFICATION_HOOKS_ITEM.kind,
    hooksOf,
  );
  const put = useMutation<
    EnvironmentConfigurationItemWriteResponse,
    EnvironmentCloudError,
    TeamHooksWrite
  >({
    mutationKey: environmentMutationKeys.configurationItemsPut(),
    mutationFn: (request) => {
      if (!canEdit || environmentId === null)
        throw new EnvironmentCloudError("forbidden", NEEDS_PERMISSION_MESSAGE);
      if (cloud === null)
        throw new EnvironmentCloudError(
          "no_response",
          NEEDS_CONNECTION_MESSAGE.settings,
        );
      return putConfigurationItem(cloud(), {
        environmentId,
        kind: NOTIFICATION_HOOKS_ITEM.kind,
        key: NOTIFICATION_HOOKS_ITEM.key,
        os: null,
        value: request.hooks.map((hook) => ({ ...hook, held: false })),
        revision: request.revision,
      });
    },
    onSettled: () =>
      environmentId === null
        ? Promise.resolve()
        : queries.invalidateQueries({
            predicate: (query) =>
              configurationReadMatches(query.queryKey, environmentId, [
                "environment.configuration.items",
              ]),
          }),
  });
  return { read, put, canEdit };
}
