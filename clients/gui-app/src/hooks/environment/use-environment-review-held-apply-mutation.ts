import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  applyReviewChoice,
  type ReviewChoiceOutcome,
  type ReviewHeldEntry,
} from "@traycer-clients/shared/environment/environment-review";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HeldApplyChoice } from "@/components/settings/move/retrospective-copy";
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

// The app's own call to authn; no host method of this name.
const METHOD = "environment.review.applyChoice";

/** Either answer leaves the row in the review; the reread draws it. */
export function useEnvironmentReviewHeldApplyMutation(
  entries: readonly ReviewHeldEntry[],
) {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const { environmentId } = usePersonalEnvironment(true);
  return useMutation<
    ReviewChoiceOutcome,
    HostRpcError,
    { readonly heldId: string; readonly choice: HeldApplyChoice }
  >({
    mutationKey: environmentMutationKeys.reviewApplyChoice(),
    mutationFn: ({ heldId, choice }) =>
      withHostQueryErrorBoundary(METHOD, async () => {
        cloudVerdictPreflight(METHOD)();
        if (cloud === null || environmentId === null)
          throw hostClientUnavailableError(METHOD);
        const entry = entries.find((row) => row.entryId === heldId);
        if (entry === undefined) return { outcome: "gone" };
        try {
          return await applyReviewChoice(cloud(), environmentId, entry, choice);
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
