import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { PushSeverity } from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

type PushMutedSeveritiesQuery = UseQueryResult<readonly PushSeverity[]>;

/**
 * The severities this phone is not pushed for, as the phone stored them for
 * the signed-in account - the phone is the authority, so this is never a
 * server read. Disabled on the shells without OS push (desktop, dev web,
 * tests), where the rows are hidden, and while no account is signed in.
 *
 * Keyed by account: the phone keeps one set per account, and this cache
 * outlives a sign-out. `onChange` fires after the phone stores a new set and
 * when its login session changes, so the switches settle on a fresh read of
 * what was kept rather than on what was asked for.
 */
export function usePushMutedSeveritiesQuery(): PushMutedSeveritiesQuery {
  const { pushPermission } = useRunnerHost();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (pushPermission === null) return;
    const subscription = pushPermission.onChange(() => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushMutedSeveritiesAll(),
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [pushPermission, queryClient]);

  return useQuery(
    // `pushPermission` is absent from the key for the reason given in
    // `usePushPermissionQuery`: it is the one device, not a parameter.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<readonly PushSeverity[]>({
      queryKey: runnerQueryKeys.pushMutedSeverities(userId),
      queryFn: () => {
        if (pushPermission === null) {
          throw new Error("This phone has no push notifications to read.");
        }
        return pushPermission.getMutedSeverities();
      },
      enabled: pushPermission !== null && userId !== null,
      // Re-read on every mount: the read is local and cheap, and a cached
      // answer may predate a change made while the rows were not showing.
      staleTime: 0,
    }),
  );
}
