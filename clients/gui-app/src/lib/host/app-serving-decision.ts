import { useCallback } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  callEnvironmentIdOf,
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { getHostBindingSnapshot, useHostBinding } from "@/lib/host/runtime";
import {
  readHostServingDecision,
  useHostServingDecision,
} from "@/lib/host/serving-decision";

/**
 * The serving decision resolved against the app's live directory: the
 * runtime's, which is where every requester resolves its entries too.
 */
function findAppHostById(hostId: string): HostDirectoryEntry | null {
  return getHostBindingSnapshot()?.hostClient.resolveHostById(hostId) ?? null;
}

/** The decision now, for a caller outside a render. */
export function readAppServingDecision(): HostServingDecision {
  return readHostServingDecision(findAppHostById);
}

/** The decision for a render: re-renders when the answering peer may move. */
export function useAppServingDecision(): HostServingDecision {
  const binding = useHostBinding();
  const findHostById = useCallback(
    (hostId: string): HostDirectoryEntry | null =>
      binding?.hostClient.resolveHostById(hostId) ?? null,
    [binding],
  );
  return useHostServingDecision(findHostById);
}

/**
 * The host id that answers `method` for a caller naming `callerHostId`, as it
 * stands now: the serving tier a key or a capability read is filed under.
 * `params` supplies the environment a Guide or Skills call names.
 */
export function readServingTierHostId(
  method: string,
  callerHostId: string | null,
  selectedHostId: string | null,
  params: unknown,
): string | null {
  return hostRpcServingTierHostId(
    method,
    callerHostId,
    readProcessHostRpcTierPlan(),
    selectedHostId,
    readAppServingDecision(),
    callEnvironmentIdOf(params),
  );
}
