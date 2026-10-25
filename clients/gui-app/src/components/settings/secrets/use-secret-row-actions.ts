import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";

export function useSecretRowActions(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  /** The secret by id, and its current version as the list last named it. */
  readonly secret: Pick<EnvironmentSecret, "secretId" | "currentVersionId">;
  readonly onChanged: () => void;
}) {
  const { environmentId, resolved } = useAddressedEnvironment();
  const queryClient = useQueryClient();
  const versions = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.versions"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: props.secret.secretId, environmentId },
    requiredHostMethodVersion: () =>
      environmentId === null
        ? null
        : {
            method: "environment.secrets.versions",
            version: { major: 1, minor: 1 },
          },
    options: { enabled: resolved },
  });
  const verify = useHostMutation<HostRpcRegistry, "environment.secrets.verify">(
    {
      client: props.client,
      method: "environment.secrets.verify",
      mapVariables: (variables) => variables,
      requiredHostMethodVersion: (variables) =>
        variables.environmentId === null
          ? null
          : {
              method: "environment.secrets.verify",
              version: { major: 1, minor: 1 },
            },
      options: { mutationKey: settingsDetailsMutationKeys.secretVerify() },
    },
  );
  const remove = useHostMutation<
    HostRpcRegistry,
    "environment.secrets.destroy",
    { readonly hostId: string | null }
  >({
    client: props.client,
    method: "environment.secrets.destroy",
    mapVariables: (variables) => variables,
    // Remove targets the current version: @1.0 refuses it, @1.1 revokes it,
    // whatever the environment scope.
    requiredHostMethodVersion: () => ({
      method: "environment.secrets.destroy",
      version: { major: 1, minor: 1 },
    }),
    options: {
      mutationKey: settingsDetailsMutationKeys.secretDestroy(),
      onMutate: () => ({ hostId: props.hostId }),
      onSuccess: async (answer, _variables, captured) => {
        if (answer.outcome === "refused") return;
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              captured.hostId,
              "environment.secrets.versions",
            ),
          }),
          queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              captured.hostId,
              "environment.secrets.list",
            ),
          }),
        ]);
        props.onChanged();
      },
    },
  });
  const currentVersion = versions.data?.versions.find(
    (version) => version.current,
  );
  // A freshly answered versions read owns the current id. A list id must not
  // override a response that says there is no current value left.
  const currentVersionId =
    versions.data === undefined
      ? props.secret.currentVersionId
      : (currentVersion?.versionId ?? null);
  return {
    environmentId,
    versions,
    verify,
    remove,
    currentVersion,
    currentVersionId,
  };
}
