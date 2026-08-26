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
 * This phone's OS push permission, for the Settings → Notifications "This
 * phone" row. Disabled - and therefore never fetched - on the shells that
 * have no OS push at all (desktop, dev web, tests), where the row is hidden
 * outright.
 *
 * The subscription is the sanctioned "external sync" effect: the state can
 * change with this app in the background (the person flips the switch in the
 * OS Settings app), and `onChange` carries no state - it only says the value
 * MAY have moved, so the answer comes from re-running `get()` through the
 * cache rather than from the signal.
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
    // `pushPermission` is deliberately absent from the key. It is not a
    // parameter of the question - it IS the device, and a renderer has exactly
    // one, so a static key is already the read's full scope (the same reason
    // `logLevels()` and `installedFonts()` are static). Keying on it would only
    // buy refetches on shell-instance drift, and the object is method-only, so
    // TanStack's structural hash would serialize every instance to `{}` and
    // discriminate nothing anyway.
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
      // Never serve this from cache without asking. The app default holds a
      // query fresh for 60s, but the OS owns this value and moves it while
      // Traycer is backgrounded - and the `onChange` subscription above is
      // disposed the moment this row unmounts, so nothing invalidates in
      // between. Without this, reopening Notifications within a minute of
      // enabling push in the OS Settings app renders "Off · Open Settings" on
      // a phone where push is already on.
      staleTime: 0,
    }),
  );
}
