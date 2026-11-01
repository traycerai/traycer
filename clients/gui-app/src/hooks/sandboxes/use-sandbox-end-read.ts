import { useEffect, useState } from "react";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useTaskHosts } from "@/hooks/epic/use-task-hosts-query";

/**
 * Reads the task's hosts once when a sandbox's state turns unknown, rather
 * than leaving it to their poll: a row leaves the sandbox list at `destroyed`,
 * when the task's end record exists. `true` until that read answers or its
 * first attempt fails, whatever its retries go on to do, so no surface calls
 * the sandbox unavailable before its answer. Every chat surface that names a
 * sandbox's state goes through this one edge.
 */
export function useSandboxEndRead(
  epicId: string,
  stateUnknown: boolean,
): boolean {
  const { failureCount, isEnabled, refetch } = useTaskHosts(
    useEpicSessionHostClient(),
    epicId,
  );
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
    if (reads === 0 || !isEnabled) return undefined;
    let active = true;
    // A read already out may have been sent before the row left: this one
    // restarts it, so its answer is from after the edge.
    void refetch().finally(() => {
      if (active) setAnswered(reads);
    });
    return () => {
      active = false;
    };
  }, [isEnabled, reads, refetch]);
  return stateUnknown && isEnabled && answered < reads && failureCount === 0;
}
