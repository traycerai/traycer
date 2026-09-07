import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { PushPermissionState } from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { useRunnerHost } from "@/providers/use-runner-host";

export type PushPermissionQuery = UseQueryResult<PushPermissionState>;

/**
 * Disabled on shells with no OS push. `onChange` carries no state; re-run `get()` through the cache rather than trusting the signal.
 */
export function usePushPermissionQuery(): PushPermissionQuery {
  const { pushPermission } = useRunnerHost();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (pushPermission === null) return;
    const subscription = pushPermission.onChange(() => {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.pushPermission(),
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [pushPermission, queryClient]);

  return useQuery(
    // `pushPermission` is the device, not a param; keying on it hashes every instance to `{}`.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryOptions<PushPermissionState>({
      queryKey: runnerQueryKeys.pushPermission(),
      queryFn: () => {
        if (pushPermission === null) {
          throw new Error("This phone has no OS push permission to read.");
        }
        return pushPermission.get();
      },
      enabled: pushPermission !== null,
      // Never serve this from cache without asking.
      // The app default holds a query fresh for 60s, but the OS owns this value and moves it while Traycer is backgrounded - and the `onChange` subscription above is disposed the moment this row unmounts, so nothing invalidates in between.
      staleTime: 0,
    }),
  );
}
