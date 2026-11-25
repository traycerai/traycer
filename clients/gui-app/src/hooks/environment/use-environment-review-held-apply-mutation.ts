import { useQueryClient } from "@tanstack/react-query";
import {
  applyReviewChoice,
  type ReviewChoiceOutcome,
  type ReviewHeldEntry,
} from "@traycer-clients/shared/environment/environment-review";
import type { EnvironmentReviewHeldKeepResponse } from "@traycer/protocol/host/environment-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PersonalHeldChoice } from "@/components/settings/move/retrospective-copy";
import type { HostRpcRegistry } from "@/lib/host";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys";

// The app's own call to authn; no host method of this name.
const METHOD = "environment.review.applyChoice";

/** The review owns the row's presence after any choice. */
export function useEnvironmentReviewHeldApplyMutation(
  entries: readonly ReviewHeldEntry[],
  keepClient: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const { environmentId } = usePersonalEnvironment(true);
  return usePressCapturedMutation<
    ReviewChoiceOutcome | EnvironmentReviewHeldKeepResponse,
    HostRpcError,
    { readonly heldId: string; readonly choice: PersonalHeldChoice },
    ReviewHeldEntry | undefined
  >(
    // A replacement can arrive before the dispatch. Send the revision shown
    // when the person chose, so the host or authn can refuse a stale choice.
    ({ heldId }) => entries.find((row) => row.entryId === heldId),
    {
      mutationKey: environmentMutationKeys.reviewApplyChoice(),
      mutationFn: ({ heldId, choice }, entry) =>
        withHostQueryErrorBoundary(METHOD, async () => {
          if (entry === undefined) return { outcome: "gone" };
          if (choice === "keep") {
            if (
              keepClient === null ||
              keepClient.getActiveHostId() !== entry.hostId
            )
              throw hostClientUnavailableError("environment.review.heldKeep");
            return keepClient.request("environment.review.heldKeep", {
              heldId,
              revision: entry.heldRevision,
            });
          }
          cloudVerdictPreflight(METHOD)();
          if (cloud === null || environmentId === null)
            throw hostClientUnavailableError(METHOD);
          try {
            return await applyReviewChoice(
              cloud(),
              environmentId,
              entry,
              choice,
            );
          } catch (error) {
            throw environmentCloudHostError(METHOD, error);
          }
        }),
      onSettled: (_data, _error, { choice }) => {
        void invalidateEnvironmentReads(
          queryClient,
          choice === "keep"
            ? [
                "environment.review",
                "environment.localOverrides",
                "config.env.list",
                "providers.list",
              ]
            : ["environment.review"],
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't apply that choice.");
      },
    },
  );
}
