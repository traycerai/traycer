import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { hostQueryEntryKey } from "@/hooks/host/use-host-query";
import { readAppServingDecision } from "@/lib/host/app-serving-decision";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface EpicCollaboratorsCacheOwner {
  readonly hostId: string | null;
  readonly viewerUserId: string;
}

export function captureEpicCollaboratorsCacheOwner(
  client: Pick<HostRequester<HostRpcRegistry>, "getActiveHostId"> | null,
): EpicCollaboratorsCacheOwner {
  return {
    hostId: client?.getActiveHostId() ?? null,
    viewerUserId: useAuthStore.getState().contextMetadata?.userId ?? "",
  };
}

export function epicCollaboratorsCacheIdentity(
  viewerUserId: string,
): readonly [string] {
  return [viewerUserId];
}

export function epicCollaboratorsQueryKey(
  hostId: string,
  epicId: string,
  viewerUserId: string,
): readonly unknown[] {
  return hostQueryEntryKey<HostRpcRegistry, "epic.listCollaborators">({
    hostId,
    effectiveHostId: hostId,
    method: "epic.listCollaborators",
    params: { epicId },
    cacheKeyIdentity: epicCollaboratorsCacheIdentity(viewerUserId),
    serving: readAppServingDecision(),
  });
}
