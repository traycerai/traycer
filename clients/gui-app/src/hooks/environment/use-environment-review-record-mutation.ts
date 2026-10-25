import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

/** Records that the retrospective sheet was shown, or that Got it acknowledged it. */
export function useEnvironmentReviewRecordMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  return useHostScopedMutationForClient(client, {
    method: "environment.review.record",
    mutationKey: environmentMutationKeys.reviewRecord(),
    errorMessage: "Couldn't record the sheet.",
    invalidateMethods: ["environment.review"],
  });
}
