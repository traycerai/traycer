import type { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";

const HOST_LIST_METHOD = "environment.host.list";

/**
 * The environment an `environment.host.list` key asks about, under any host
 * scope (`["host", hostId?, method, { environmentId }, ...]`); `null` for any
 * other key.
 */
export function hostListEnvironmentId(
  queryKey: readonly unknown[],
): string | null {
  if (!hostQueryKeys.matchesMethodOnAnyHost(queryKey, HOST_LIST_METHOD)) {
    return null;
  }
  const params = queryKey[queryKey.indexOf(HOST_LIST_METHOD) + 1];
  if (
    typeof params === "object" &&
    params !== null &&
    "environmentId" in params &&
    typeof params.environmentId === "string"
  ) {
    return params.environmentId;
  }
  return null;
}

/**
 * A configuration write starts a new round of delivery reports, whichever
 * requester read them: the pool's and a team host's lists of one environment
 * say the same thing.
 */
export function invalidateEnvironmentHostReports(
  queryClient: QueryClient,
  environmentId: string,
): void {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      hostListEnvironmentId(query.queryKey) === environmentId,
  });
}
