import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
  type HostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  ENVIRONMENT_CLOUD_QUERY_SCOPE,
  invalidateEnvironmentReads,
} from "@/hooks/environment/use-environment-cloud";
import {
  DELTA_FED_READS,
  SECRET_READS,
} from "@/lib/environment/delta-fed-reads";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";

const DELTA_FED: ReadonlySet<string> = new Set(DELTA_FED_READS);

/** The host methods no poll ever re-reads. */
const UNPOLLED: ReadonlySet<string> = new Set(
  Object.entries(HOST_METHOD_POLL_TABLE)
    .filter(([, policy]) => policy.poll === null)
    .map(([method]) => method),
);

/**
 * A read made through `hostId`, cached under the tier that serves it, or one
 * the app makes itself on authn (a named environment's history, the
 * environment list, the review list, the notices), cached under authn's
 * scope where the pool's answer was before those reads moved.
 */
function rereadsOnFocus(
  query: Query,
  hostId: string,
  plan: HostRpcTierPlan,
): boolean {
  const [scope, host, method] = query.queryKey;
  if (scope !== "host" || typeof method !== "string") return false;
  if (
    host !== ENVIRONMENT_CLOUD_QUERY_SCOPE &&
    host !== hostRpcServingTierHostId(method, hostId, plan, null)
  )
    return false;
  if (DELTA_FED.has(method)) return true;
  return query.getObserversCount() > 0 && UNPOLLED.has(method);
}

/**
 * Re-reads a Local row's settings when the window gains focus: `hostId`'s
 * delta-fed reads, and every read its page renders that never polls. A Local
 * row is a computer's own settings, and no status reports their revision, so
 * a change made on that computer outside this window (another window, the
 * CLI, an agent) reaches an open page only this way. Its secrets are read
 * from authn, under the environment that computer runs, and are re-read with
 * them. The window's own `focus` event, as `useRereadConfigurationOnFocus`
 * uses. `null` listens to nothing.
 */
export function useRereadHostReadsOnFocus(hostId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (hostId === null) return undefined;
    const plan = readProcessHostRpcTierPlan();
    const listener = (): void => {
      void queryClient.invalidateQueries({
        predicate: (query) => rereadsOnFocus(query, hostId, plan),
      });
      void invalidateEnvironmentReads(queryClient, SECRET_READS);
    };
    window.addEventListener("focus", listener);
    return () => {
      window.removeEventListener("focus", listener);
    };
  }, [hostId, queryClient]);
}
