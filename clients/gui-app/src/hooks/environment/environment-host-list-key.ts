import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

const HOST_LIST_METHOD = "environment.host.list";

/**
 * The account-wide read that carries the reader's role in each configuration.
 * It takes no `environmentId`, so it is matched by method alone.
 */
const ENVIRONMENT_LIST_METHOD = "environment.list";

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
 * Reads whose source moves with the configuration's apply position.
 */
export const CONFIGURATION_ITEM_READS = [
  "environment.configuration.items",
  "environment.configuration.mcpServers.list",
  "environment.members",
  "environment.members.seats",
  "environment.plans.list",
] as const;

/** Focus and stale-write recovery also refresh independent receipt/room state. */
export const CONFIGURATION_READS = [
  ...CONFIGURATION_ITEM_READS,
  "environment.configuration.skills.list",
  "environment.configuration.guide.get",
  "environment.secrets.list",
  "environment.secrets.versions",
] as const;

/**
 * A configuration write moves `reads` of that environment, and its delivery
 * reports, under EVERY requesting host. The configuration is one record, but
 * each host's answer to a read is cached apart:
 * a page that read on the surface host while its write ran on the viewing
 * host (`TeamViewingHostBinding`) would otherwise keep the old answer, and
 * send its revision with the next write.
 *
 * The reader's own role moves with them. It comes from `environment.list`, so
 * that read is marked stale here too: without it a page kept the form its old
 * role was given long after its items had been read again, while every page
 * whose content changes shape for the new role appeared to switch at once.
 *
 * The cost is an account-wide read, refetched once per active
 * `environment.list` key — one on a pooled build, one per host scope
 * otherwise — each time this runs: on a revision change, on focus, on
 * stale-write recovery, and after the writes that call it. The list itself
 * never polls; the revision does, and only a revision that moved gets here.
 */
export function invalidateConfigurationReads(
  queryClient: QueryClient,
  environmentId: string,
  reads: ReadonlyArray<keyof HostRpcRegistry & string>,
): void {
  const methods = [HOST_LIST_METHOD, ...reads];
  void queryClient.invalidateQueries({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(
        query.queryKey,
        ENVIRONMENT_LIST_METHOD,
      ) ||
      methods.some(
        (method) => readEnvironmentId(query.queryKey, method) === environmentId,
      ),
  });
}
