import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { hostQueryEntryKey } from "@/hooks/host/use-host-query";
import { readAppServingDecision } from "@/lib/host/app-serving-decision";
import { useAuthStore } from "@/stores/auth/auth-store";
import { lastingHostRefusal } from "@/lib/host/lasting-host-refusal";

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

export function epicCollaboratorsQueryScope(
  epicId: string,
  viewerUserId: string,
) {
  return {
    method: "epic.listCollaborators",
    params: { epicId },
    cacheKeyIdentity: [viewerUserId],
  } as const;
}

export function canReadCachedCollaborators(error: unknown): boolean {
  const refusal = lastingHostRefusal(error);
  return refusal !== "access-refused" && refusal !== "signed-out";
}

export function epicCollaboratorsQueryKey(
  hostId: string,
  epicId: string,
  viewerUserId: string,
): readonly unknown[] {
  return hostQueryEntryKey<HostRpcRegistry, "epic.listCollaborators">({
    hostId,
    effectiveHostId: hostId,
    ...epicCollaboratorsQueryScope(epicId, viewerUserId),
    serving: readAppServingDecision(),
  });
}
