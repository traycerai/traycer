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

export type PushMutedSeveritiesQuery = UseQueryResult<readonly PushSeverity[]>;

/**
 * The severities this phone is not pushed for, as the phone stored them - the
 * phone is the authority, so this is never a server read. Disabled on the
 * shells without OS push (desktop, dev web, tests), where the rows are hidden.
 *
 * `onChange` fires after the phone stores a new set, so the switches settle
 * on a fresh read of what was kept rather than on what was asked for.
 */
export function usePushMutedSeveritiesQuery(): PushMutedSeveritiesQuery {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (pushPermission === null) return;
    const subscription = pushPermission.onChange(() => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushMutedSeverities(),
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
      queryKey: runnerQueryKeys.pushMutedSeverities(),
      queryFn: () => {
        if (pushPermission === null) {
          throw new Error("This phone has no push notifications to read.");
        }
        return pushPermission.getMutedSeverities();
      },
      enabled: pushPermission !== null,
      // The phone keeps one set per account, so a cached answer may belong to
      // whoever was signed in before. The read is local and cheap.
      staleTime: 0,
    }),
  );
}
