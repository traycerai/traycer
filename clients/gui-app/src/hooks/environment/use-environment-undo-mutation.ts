import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  undoNotice,
  type UndoOutcome,
} from "@traycer-clients/shared/environment/environment-review";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys";

const METHOD = "environment.undo";

const UNDO_READS = [
  "environment.notices",
  "environment.status",
  "config.env.list",
  "providers.list",
] as const;

export function useEnvironmentUndoMutation() {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const { environmentId } = usePersonalEnvironment(true);
  return useMutation<UndoOutcome, HostRpcError, { readonly noticeId: string }>({
    mutationKey: environmentMutationKeys.undo(),
    mutationFn: ({ noticeId }) =>
      withHostQueryErrorBoundary(METHOD, async () => {
        cloudVerdictPreflight(METHOD)();
        if (cloud === null || environmentId === null)
          throw hostClientUnavailableError(METHOD);
        try {
          return await undoNotice(cloud(), environmentId, noticeId);
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
