import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";

export interface EpicRecordMutationTarget {
  readonly hostId: string | null;
}

export interface EpicRecordMutationContext extends EpicRecordMutationTarget {
  readonly viewerHostId: string | null;
}

/** Record writes follow their owner; the viewing epic may only hold a replica. */
export function useEpicRecordMutationClient(): (
  target: EpicRecordMutationTarget,
) => HostClient<HostRpcRegistry> | null {
  const sessionClient = useEpicSessionHostClient();
  const binding = useHostBinding();
  return ({ hostId }) => {
    if (hostId === null) return null;
    if (sessionClient?.getActiveHostId() === hostId) return sessionClient;
    return resolveNamedHostClient(binding, hostId);
  };
}
