import { useMemo } from "react";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import type { RestingSandboxHost } from "@/hooks/sandboxes/use-resting-sandbox-host";
import { useSandboxWakeWait } from "@/hooks/sandboxes/use-sandbox-wake-wait";

/** These surfaces hold no read of the host: the relay's word answers. */
const NOT_READ_YET = { hostAnswered: false, wakeSent: false };

/**
 * The sandbox `hostId` names while it comes up: moving, or awake with a host
 * that has not first reported in this wake. `null` for any other host.
 */
export function useWakingSandboxHost(
  hostId: string | null,
): RestingSandboxHost | null {
  const row =
    useSandboxList().data?.sandboxes.find(
      (sandbox) => sandbox.hostId === hostId,
    ) ?? null;
  const wait = useSandboxWakeWait(row, NOT_READ_YET);
  const name = row === null ? null : row.displayName;
  return useMemo((): RestingSandboxHost | null => {
    if (hostId === null || name === null || wait === null) return null;
    return { hostId, name, verb: wait === "resuming" ? "resume" : "start" };
  }, [hostId, name, wait]);
}
