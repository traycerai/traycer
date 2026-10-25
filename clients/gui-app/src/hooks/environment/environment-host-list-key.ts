import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

const HOST_LIST_METHOD = "environment.host.list";

/**
 * The environment a `method` key asks about, under any host scope
 * (`["host", hostId?, method, { environmentId }, ...]`); `null` for any other
 * key.
 */
function readEnvironmentId(
  queryKey: readonly unknown[],
  method: string,
): string | null {
  if (!hostQueryKeys.matchesMethodOnAnyHost(queryKey, method)) return null;
  const params = queryKey[queryKey.indexOf(method) + 1];
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

/** The environment an `environment.host.list` key asks about, or `null`. */
export function hostListEnvironmentId(
  queryKey: readonly unknown[],
): string | null {
  return readEnvironmentId(queryKey, HOST_LIST_METHOD);
}

/**
 * Every read a configuration's pages render. None of them polls, so a change
 * made elsewhere (the dashboard, another computer, another person) reaches an
 * open page only through a reread.
 */
export const CONFIGURATION_READS = [
  "environment.configuration.items",
  "environment.configuration.mcpServers.list",
  "environment.configuration.skills.list",
  "environment.configuration.guide.get",
  "environment.plans.list",
] as const;

/**
 * A configuration write moves `reads` of that environment, and its delivery
 * reports, under EVERY requesting host. The configuration is one record, but
 * each host's answer to a read is cached apart and none of these reads polls:
 * a page that read on the surface host while its write ran on the viewing
 * host (`TeamViewingHostBinding`) would otherwise keep the old answer, and
 * send its revision with the next write.
 */
export function invalidateConfigurationReads(
  queryClient: QueryClient,
  environmentId: string,
  reads: ReadonlyArray<keyof HostRpcRegistry & string>,
): void {
  const methods = [HOST_LIST_METHOD, ...reads];
  void queryClient.invalidateQueries({
    predicate: (query) =>
      methods.some(
        (method) => readEnvironmentId(query.queryKey, method) === environmentId,
      ),
  });
}
