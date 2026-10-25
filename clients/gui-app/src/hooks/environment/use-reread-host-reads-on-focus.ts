import { useQueryClient, type Query } from "@tanstack/react-query";
import { useEffect } from "react";
import { DELTA_FED_READS } from "@/lib/environment/delta-fed-reads";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";

const DELTA_FED: ReadonlySet<string> = new Set(DELTA_FED_READS);

/** The host methods no poll ever re-reads. */
const UNPOLLED: ReadonlySet<string> = new Set(
  Object.entries(HOST_METHOD_POLL_TABLE)
    .filter(([, policy]) => policy.poll === null)
    .map(([method]) => method),
);

/** A read of `hostId` that only a reread brings up to date. */
function rereadsOnFocus(query: Query, hostId: string): boolean {
  const [scope, host, method] = query.queryKey;
  if (scope !== "host" || host !== hostId || typeof method !== "string")
    return false;
  if (DELTA_FED.has(method)) return true;
  return query.getObserversCount() > 0 && UNPOLLED.has(method);
}

/**
 * Re-reads a Local row's settings when the window gains focus: `hostId`'s
 * delta-fed reads, and every read its page renders that never polls. A Local
 * row is a computer's own settings, and no status reports their revision, so
 * a change made on that computer outside this window (another window, the
 * CLI, an agent) reaches an open page only this way. The window's own `focus`
 * event, as `useRereadConfigurationOnFocus` uses. `null` listens to nothing.
 */
export function useRereadHostReadsOnFocus(hostId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (hostId === null) return undefined;
    const listener = (): void => {
      void queryClient.invalidateQueries({
        predicate: (query) => rereadsOnFocus(query, hostId),
      });
    };
    window.addEventListener("focus", listener);
    return () => {
      window.removeEventListener("focus", listener);
    };
  }, [hostId, queryClient]);
}
