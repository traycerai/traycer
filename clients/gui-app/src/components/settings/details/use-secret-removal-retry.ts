import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EnvironmentSecretRemoval } from "@traycer/protocol/host/environment-schemas";
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

/** Pending host copies only: broker cleanup slots are not hosts. */
function waitingHosts(
  removal: EnvironmentSecretRemoval | null,
): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const target of removal?.targets ?? []) {
    if (
      target.target === "host" &&
      target.state === "requested" &&
      target.hostId !== null
    ) {
      hosts.set(target.hostId, target.hostName || "a host");
    }
  }
  return hosts;
}

/**
 * Retry an unfinished removal from its row or Details. Remove again on the
 * current version resumes authn's cleanup and sends a delta to retry failed
 * host work. A refusal stays beside the action; an unchanged wait is explained
 * after reading the removal again.
 */
export function useSecretRemovalRetry(
  client: HostClient<HostRpcRegistry>,
  hostId: string | null,
): DetailsItemRetry {
  const queryClient = useQueryClient();
  // One mutation keeps the reads and destroy in sequence, with a shared
  // pending/refusal state. The client is required, each call
  // enforce their version floor, and success invalidates the captured host.
  const retry = useMutation({
    mutationKey: settingsDetailsMutationKeys.secretRemovalRetry(),
    mutationFn: async (subject: DetailsSubject): Promise<string | null> => {
      const versions = await client.requestWithSignalRequiringHostMethodVersion(
        "environment.secrets.versions",
        { environmentId: subject.environmentId, secretId: subject.key },
        undefined,
        { method: "environment.secrets.versions", version: VERSION_1_1 },
      );
      // The button may have rendered before the completion reached its list.
      // A fresh terminal answer is authoritative and must never re-run Remove.
      if (versions.removal?.outcome === "destroyed") return null;
      const before = waitingHosts(versions.removal);
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
      // The destroy succeeded. A failed confirmation read must still
      // invalidate the list, without reporting that the destroy failed.
      const after = await client
        .requestWithSignalRequiringHostMethodVersion(
          "environment.secrets.versions",
          { environmentId: subject.environmentId, secretId: subject.key },
          undefined,
          { method: "environment.secrets.versions", version: VERSION_1_1 },
        )
        .catch(() => null);
      if (
        after === null ||
        after.removal === null ||
        after.removal.outcome === "destroyed"
      )
        return null;
      const waiting = waitingHosts(after.removal);
      if (
        waiting.size === 0 ||
        waiting.size !== before.size ||
        [...waiting.keys()].some((id) => !before.has(id))
      )
        return null;
      if (waiting.size === 1) {
        return `Still waiting for ${[...waiting.values()][0]}. It deletes its copy the next time it's reachable.`;
      }
      return `Still waiting for ${waiting.size} hosts. They delete their copies the next time they're reachable.`;
    },
    onMutate: () => ({ hostId }),
    onSuccess: async (message, _subject, captured) => {
      if (message !== null) toast(message);
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
