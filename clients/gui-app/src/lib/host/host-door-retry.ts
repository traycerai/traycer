import { reopenHostConnectionNow } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostTokenSource } from "@traycer-clients/shared/auth/host-token-source";
import { useAuthStore } from "@/stores/auth/auth-store";
import { hostDoorStateFor } from "@/stores/host/host-door-state-store";

/** Each owner holds its own rebuild timer, which no reconnect lane reaches. */
const rebuildOwners = new Map<string, Set<() => void>>();

export function onHostDoorRetry(
  hostId: string,
  rebuildNow: () => void,
): () => void {
  const owners = rebuildOwners.get(hostId) ?? new Set<() => void>();
  owners.add(rebuildNow);
  rebuildOwners.set(hostId, owners);
  return () => {
    owners.delete(rebuildNow);
    if (owners.size === 0 && rebuildOwners.get(hostId) === owners)
      rebuildOwners.delete(hostId);
  };
}

/**
 * Only a token the host called expired is replaced first; other states redial with
 * the held token. Clears no state: the next admitted open does.
 */
export async function retryHostDoor(
  hostId: string,
  hostTokens: HostTokenSource,
): Promise<void> {
  const userId = useAuthStore.getState().contextMetadata?.userId ?? null;
  try {
    // Whatever the mint answers, the redial below asks again on refusal.
    if (userId !== null && hostDoorStateFor(hostId)?.kind === "token-expired")
      await hostTokens.obtain(userId, hostId, true, null);
  } finally {
    reopenHostConnectionNow(hostId);
    for (const rebuildNow of [...(rebuildOwners.get(hostId) ?? [])])
      rebuildNow();
  }
}
