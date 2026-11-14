import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import {
  useSecretsRead,
  useSecretsWrite,
} from "@/hooks/environment/use-environment-secrets-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { settingsDetailsMutationKeys } from "@/lib/query-keys/settings-details-query-keys";

export function useSecretRowActions(props: {
  readonly client: HostClient<HostRpcRegistry>;
  /** The secret by id, and its current version as the list last named it. */
  readonly secret: Pick<EnvironmentSecret, "secretId" | "currentVersionId">;
  readonly removing: boolean;
  readonly onChanged: () => void;
}) {
  const { environmentId, resolved } = useAddressedEnvironment();
  const queryClient = useQueryClient();
  const [polling, setPolling] = useState(props.removing);
  const versions = useSecretsRead({
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: props.secret.secretId, environmentId },
    enabled: resolved,
    poll: polling,
  });
  const removal = versions.data?.removal;
  const unfinished =
    removal?.outcome !== "destroyed" &&
    (props.removing || (removal !== undefined && removal !== null));
  if (polling !== unfinished) setPolling(unfinished);
  const verify = useSecretsWrite({
    client: props.client,
    method: "environment.secrets.verify",
    mutationKey: settingsDetailsMutationKeys.secretVerify(),
  });
  // Remove targets the current version, which the latest version revokes.
  const remove = useSecretsWrite({
    client: props.client,
    method: "environment.secrets.destroy",
    mutationKey: settingsDetailsMutationKeys.secretDestroy(),
    onSuccess: async (answer) => {
      if (answer.outcome === "refused") return;
      await invalidateEnvironmentReads(queryClient, [
        "environment.secrets.versions",
        "environment.secrets.list",
      ]);
      props.onChanged();
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
