import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { DetailsItemRetry } from "@/components/settings/details/details-drawer";
import type { HostRpcRegistry } from "@/lib/host";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  settingsDetailsMutationKeys,
  settingsDetailsQueryKeys,
} from "@/lib/query-keys/settings-details-query-keys";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import type { DetailsSubject } from "@/lib/settings-details-entry";

const VERSION_1_1 = { major: 1, minor: 1 } as const;

/**
 * Retry an unfinished removal from its row or Details. Remove again on the
 * current version resumes authn's cleanup and sends a delta to retry failed
 * host work. A refusal stays beside the action.
 */
export function useSecretRemovalRetry(
  client: HostClient<HostRpcRegistry>,
  hostId: string | null,
): DetailsItemRetry {
  const queryClient = useQueryClient();
  // One mutation keeps the fresh version read and its destroy in sequence,
  // with a shared pending/refusal state. The client is required, both calls
  // enforce their version floor, and success invalidates the captured host.
  const retry = useMutation({
    mutationKey: settingsDetailsMutationKeys.secretRemovalRetry(),
    mutationFn: async (subject: DetailsSubject): Promise<void> => {
      const versions = await client.requestWithSignalRequiringHostMethodVersion(
        "environment.secrets.versions",
        { environmentId: subject.environmentId, secretId: subject.key },
        undefined,
        { method: "environment.secrets.versions", version: VERSION_1_1 },
      );
      // The button may have rendered before the completion reached its list.
      // A fresh terminal answer is authoritative and must never re-run Remove.
      if (versions.removal?.outcome === "destroyed") return;
      const current = versions.versions.find((version) => version.current);
      if (current === undefined) {
        throw new Error("There is no current version to remove.");
      }
      const answer = await client.requestWithSignalRequiringHostMethodVersion(
        "environment.secrets.destroy",
        {
          environmentId: subject.environmentId,
          secretId: subject.key,
          versionId: current.versionId,
        },
        undefined,
        { method: "environment.secrets.destroy", version: VERSION_1_1 },
      );
      if (answer.outcome === "refused") {
        throw new Error(
          secretChangeRefusalLine("destroy", answer.code) ??
            "That didn't go through.",
        );
      }
    },
    onMutate: () => ({ hostId }),
    onSuccess: async (_answer, _subject, captured) => {
      await Promise.all([
        ...SECRET_READS.map((method) =>
          queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostRpcServingTierHostId(
                method,
                captured.hostId,
                readProcessHostRpcTierPlan(),
                null,
              ),
              method,
            ),
          }),
        ),
        queryClient.invalidateQueries({
          queryKey: settingsDetailsQueryKeys.all(),
        }),
      ]);
    },
  });
  return {
    onRetry: (subject) => retry.mutate(subject),
    pending: retry.isPending,
    error: retry.error?.message ?? null,
  };
}
