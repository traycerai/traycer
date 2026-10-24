import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useConfigurationEnvironmentId } from "@/components/settings/environment/configuration-source";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";

export function useSecretVersionActions(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly onChanged: () => void;
}) {
  const environmentId = useConfigurationEnvironmentId();
  const queryClient = useQueryClient();
  const reread = async (captured: {
    readonly hostId: string | null;
  }): Promise<void> => {
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
  };
  const undo = useHostMutation<
    HostRpcRegistry,
    "environment.secrets.undo",
    { readonly hostId: string | null }
  >({
    client: props.client,
    method: "environment.secrets.undo",
    mapVariables: (variables) => variables,
    requiredHostMethodVersion: (variables) =>
      variables.environmentId === null
        ? null
        : {
            method: "environment.secrets.undo",
            version: { major: 1, minor: 1 },
          },
    options: {
      mutationKey: settingsDetailsMutationKeys.secretUndo(),
      onMutate: () => ({ hostId: props.hostId }),
      onSuccess: async (answer, _variables, captured) => {
        if (answer.outcome !== "refused") await reread(captured);
      },
    },
  });
  const destroy = useHostMutation<
    HostRpcRegistry,
    "environment.secrets.destroy",
    { readonly hostId: string | null }
  >({
    client: props.client,
    method: "environment.secrets.destroy",
    mapVariables: (variables) => variables,
    requiredHostMethodVersion: (variables) =>
      variables.environmentId === null
        ? null
        : {
            method: "environment.secrets.destroy",
            version: { major: 1, minor: 1 },
          },
    options: {
      mutationKey: settingsDetailsMutationKeys.secretDestroy(),
      onMutate: () => ({ hostId: props.hostId }),
      onSuccess: async (answer, _variables, captured) => {
        if (answer.outcome !== "refused") await reread(captured);
      },
    },
  });
  return { environmentId, undo, destroy };
}
