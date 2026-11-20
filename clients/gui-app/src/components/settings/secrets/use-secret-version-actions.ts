import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import {
  useSecretsEnvironment,
  useSecretsWrite,
} from "@/hooks/environment/use-environment-secrets-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";

export function useSecretVersionActions(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly onChanged: () => void;
}) {
  const { environmentId } = useSecretsEnvironment(props.client);
  const queryClient = useQueryClient();
  const reread = async (): Promise<void> => {
    await invalidateEnvironmentReads(queryClient, [
      "environment.secrets.versions",
      "environment.secrets.list",
    ]);
    props.onChanged();
  };
  const undo = useSecretsWrite({
    method: "environment.secrets.undo",
    mutationKey: settingsDetailsMutationKeys.secretUndo(),
    onSuccess: async (answer) => {
      if (answer.outcome !== "refused") await reread();
    },
  });
  const destroy = useSecretsWrite({
    method: "environment.secrets.destroy",
    mutationKey: settingsDetailsMutationKeys.secretDestroy(),
    onSuccess: async (answer) => {
      if (answer.outcome !== "refused") await reread();
    },
  });
  return { environmentId, undo, destroy };
}
