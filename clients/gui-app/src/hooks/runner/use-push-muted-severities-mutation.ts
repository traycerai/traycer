import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { PushSeverity } from "@traycer-clients/shared/platform/runner-host";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface PushMutedSeveritiesChange {
  /** The account whose loaded set `severities` was derived from. */
  readonly userId: string;
  /** The whole new muted set, not a change to it. */
  readonly severities: readonly PushSeverity[];
}

export type PushMutedSeveritiesMutation = UseMutationResult<
  void,
  Error,
  PushMutedSeveritiesChange
>;

/**
 * Stores the WHOLE new muted set on this phone. It resolves once the phone has
 * kept it; sending it to the server is the phone's own best-effort business.
 * The mutation stays pending until the query has re-read the stored set, so a
 * switch is never enabled showing the value from before the change.
 *
 * Fenced to the account it was started under. The set is derived from that
 * account's loaded answer, so if the person is signed in as someone else by
 * the time it runs, nothing is written: it would replace that account's
 * choice with a set they never saw. Its error is dropped the same way.
 */
export function usePushMutedSeveritiesMutation(): PushMutedSeveritiesMutation {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();
  return useMutation<void, Error, PushMutedSeveritiesChange>({
    mutationKey: runnerMutationKeys.pushMutedSeveritiesSet(),
    mutationFn: async (change) => {
      if (pushPermission === null) {
        throw new Error("This phone has no push notifications to change.");
      }
      if (signedInUserId() !== change.userId) return;
      await pushPermission.setMutedSeverities(change.severities);
    },
    onSuccess: (_data, change) =>
      queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushMutedSeverities(change.userId),
      }),
    onError: (error, change) => {
      if (signedInUserId() !== change.userId) return;
      toastFromRunnerError(error, "Couldn't change this phone's notifications");
    },
  });
}

function signedInUserId(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}
