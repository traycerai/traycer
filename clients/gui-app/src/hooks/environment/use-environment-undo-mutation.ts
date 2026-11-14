import { useMutation, useQueryClient } from "@tanstack/react-query";
import { undoNotice } from "@traycer-clients/shared/environment/environment-review";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentWriteOutcome } from "@traycer/protocol/host/environment-schemas";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys";

const METHOD = "environment.undo";

/** What an Undo changes: the notices, the host's status, the values. */
const UNDO_READS = [
  "environment.notices",
  "environment.status",
  "config.env.list",
  "providers.list",
] as const;

/**
 * Undoes one of Personal's notices, the app's own call to authn on the
 * person's sign-in. A change made since answers `stale`, which the row draws
 * with today's refusal line.
 */
export function useEnvironmentUndoMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const { environmentId } = usePersonalEnvironment(client, true);
  return useMutation<
    EnvironmentWriteOutcome,
    HostRpcError,
    { readonly noticeId: string }
  >({
    mutationKey: environmentMutationKeys.undo(),
    mutationFn: ({ noticeId }) =>
      withHostQueryErrorBoundary(METHOD, async () => {
        cloudVerdictPreflight(METHOD)();
        if (cloud === null || environmentId === null)
          throw hostClientUnavailableError(METHOD);
        try {
          return await undoNotice(cloud, environmentId, noticeId);
        } catch (error) {
          throw environmentCloudHostError(METHOD, error);
        }
      }),
    onSettled: () => {
      void invalidateEnvironmentReads(queryClient, UNDO_READS);
    },
    onError: (error) => {
      toastFromHostError(error, "Couldn't undo.");
    },
  });
}
