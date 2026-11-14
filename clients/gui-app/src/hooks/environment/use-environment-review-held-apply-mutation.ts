import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  applyReviewChoice,
  type ReviewHeldEntry,
} from "@traycer-clients/shared/environment/environment-review";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentReviewHeldApplyResponse } from "@traycer/protocol/host/environment-schemas";
import type { HeldApplyChoice } from "@/components/settings/move/retrospective-copy";
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

const METHOD = "environment.review.heldApply";

/**
 * Applies one retrospective held-row choice, the app's own call to authn on
 * the person's sign-in. Approve names the hold's revision and the live item's
 * revision the list read and showed; a hold or item that moved since leaves
 * the row in the review, and the reread draws it as it is now.
 */
export function useEnvironmentReviewHeldApplyMutation(
  client: HostClient<HostRpcRegistry> | null,
  entries: readonly ReviewHeldEntry[],
) {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const { environmentId } = usePersonalEnvironment(client, true);
  return useMutation<
    EnvironmentReviewHeldApplyResponse,
    HostRpcError,
    { readonly heldId: string; readonly choice: HeldApplyChoice }
  >({
    mutationKey: environmentMutationKeys.reviewHeldApply(),
    mutationFn: ({ heldId, choice }) =>
      withHostQueryErrorBoundary(METHOD, async () => {
        cloudVerdictPreflight(METHOD)();
        if (cloud === null || environmentId === null)
          throw hostClientUnavailableError(METHOD);
        const entry = entries.find((row) => row.entryId === heldId);
        if (entry === undefined) return { outcome: "gone" };
        try {
          return await applyReviewChoice(cloud, environmentId, entry, choice);
        } catch (error) {
          throw environmentCloudHostError(METHOD, error);
        }
      }),
    onSettled: () => {
      void invalidateEnvironmentReads(queryClient, ["environment.review"]);
    },
    onError: (error) => {
      toastFromHostError(error, "Couldn't apply that choice.");
    },
  });
}
