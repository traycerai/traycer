import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * Reads the task's hosts once when a sandbox's state turns unknown, rather
 * than leaving it to their poll: a row leaves the sandbox list at `destroyed`,
 * when the task's end record exists. `true` while that read is out, so no
 * surface calls the sandbox unavailable before its answer. Every chat surface
 * that names a sandbox's state goes through this one edge.
 */
export function useSandboxEndRead(stateUnknown: boolean): boolean {
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState({ unknown: false, reads: 0 });
  const [answered, setAnswered] = useState(0);
  if (seen.unknown !== stateUnknown) {
    setSeen({
      unknown: stateUnknown,
      reads: seen.reads + (stateUnknown ? 1 : 0),
    });
  }
  const { reads } = seen;
  useEffect(() => {
    if (reads === 0) return undefined;
    let active = true;
    // A read already out may have been sent before the row left: this one
    // restarts it, so its answer is from after the edge.
    void queryClient
      .refetchQueries({
        type: "active",
        predicate: (query) =>
          hostQueryKeys.matchesMethodOnAnyHost(
            query.queryKey,
            "epic.listTaskHosts",
          ),
      })
      .finally(() => {
        if (active) setAnswered(reads);
      });
    return () => {
      active = false;
    };
  }, [queryClient, reads]);
  return stateUnknown && answered < reads;
}
