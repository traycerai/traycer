import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { EnvironmentSecretRemoval } from "@traycer/protocol/host/environment-schemas";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { DetailsItemRetry } from "@/components/settings/details/details-drawer";
import {
  ENVIRONMENT_CLOUD_QUERY_SCOPE,
  invalidateEnvironmentReads,
  useEnvironmentCloudSender,
} from "@/hooks/environment/use-environment-cloud";
import type { HostRpcRegistry } from "@/lib/host";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  settingsDetailsMutationKeys,
  settingsDetailsQueryKeys,
} from "@/lib/query-keys/settings-details-query-keys";
import { secretChangeRefusalLine } from "@/lib/sandboxes/secret-change-refusal-copy";
import { removalWithFailures } from "@/components/settings/secrets/secret-removal-lines";
import type { DetailsSubject } from "@/lib/settings-details-entry";

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

/** The versions contract omits failures; keep the same environment list's evidence. */
function hasKnownCleanupFailure(
  queryClient: QueryClient,
  subject: DetailsSubject,
  removal: EnvironmentSecretRemoval,
): boolean {
  const lists = queryClient.getQueriesData<
    ResponseOfMethod<HostRpcRegistry, "environment.secrets.list">
  >({
    queryKey: hostQueryKeys.method(
      // A named environment's list is the app's own read from authn.
      ENVIRONMENT_CLOUD_QUERY_SCOPE,
      "environment.secrets.list",
      { environmentId: subject.environmentId },
    ),
  });
  for (const [, list] of lists) {
    const listed =
      list?.removed.find((secret) => secret.id === subject.key)?.removal ??
      null;
    if (
      removalWithFailures(removal, listed).targets.some(
        (target) =>
          target.target === "host" &&
          target.state === "requested" &&
          target.failedAt !== null,
      )
    )
      return true;
  }
  return false;
}

/**
 * Retry an unfinished removal from its row or Details. Remove again on the
 * current version resumes authn's cleanup and sends a delta to retry failed
 * host work. A refusal stays beside the action; an unchanged wait is explained
 * after reading the removal again.
 */
export function useSecretRemovalRetry(): DetailsItemRetry {
  const queryClient = useQueryClient();
  // A Details subject always names its environment, so its secrets are the
  // app's own calls to authn.
  const send = useEnvironmentCloudSender();
  // One mutation keeps the reads and the destroy in sequence, with a shared
  // pending and refusal state. Success marks every scope's secret reads stale.
  const retry = useMutation({
    mutationKey: settingsDetailsMutationKeys.secretRemovalRetry(),
    mutationFn: async (subject: DetailsSubject): Promise<string | null> => {
      const versions = await send("environment.secrets.versions", {
        environmentId: subject.environmentId,
        secretId: subject.key,
      });
      // The button may have rendered before the completion reached its list.
      // A fresh terminal answer is authoritative and must never re-run Remove.
      if (versions.removal?.outcome === "destroyed") return null;
      const before = waitingHosts(versions.removal);
      const current = versions.versions.find((version) => version.current);
      if (current === undefined) {
        throw new Error("There is no current version to remove.");
      }
      const answer = await send("environment.secrets.destroy", {
        environmentId: subject.environmentId,
        secretId: subject.key,
        versionId: current.versionId,
      });
      if (answer.outcome === "refused") {
        throw new Error(
          secretChangeRefusalLine("destroy", answer.code) ??
            "That didn't go through.",
        );
      }
      if (before.size === 0) return null;
      // The destroy succeeded. A failed confirmation read must still
      // invalidate the list, without reporting that the destroy failed.
      const after = await send("environment.secrets.versions", {
        environmentId: subject.environmentId,
        secretId: subject.key,
      }).catch(() => null);
      if (
        after === null ||
        after.removal === null ||
        after.removal.outcome === "destroyed"
      )
        return null;
      if (hasKnownCleanupFailure(queryClient, subject, after.removal))
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
    onSuccess: async (message) => {
      if (message !== null) toast(message);
      await Promise.all([
        invalidateEnvironmentReads(queryClient, SECRET_READS),
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
