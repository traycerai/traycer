import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

/** Applies one retrospective held-row choice. The secret arm carries binding, never a value. */
export function useEnvironmentReviewHeldApplyMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  return useHostScopedMutationForClient(client, {
    method: "environment.review.heldApply",
    mutationKey: environmentMutationKeys.reviewHeldApply(),
    errorMessage: "Couldn't apply that choice.",
    invalidateMethods: ["environment.review"],
  });
}
