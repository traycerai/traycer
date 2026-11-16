import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * How many of the team's chats are running on the computer. `not-known` is
 * its own state, never folded into a count of 0: a failed read, a null answer
 * or a computer that does not answer the question says nothing about what is
 * running there.
 */
export type ClaimRunningChats =
  | { readonly kind: "counted"; readonly chats: number }
  | { readonly kind: "not-known" };

const NOT_KNOWN: ClaimRunningChats = { kind: "not-known" };

/**
 * The computer's own count of the team's chats with a turn running on it,
 * asked of that computer each time the confirm opens. Until it answers the
 * count is not known.
 */
export function useClaimRunningChats(
  hostId: string | null,
  environmentId: string | null,
): ClaimRunningChats {
  const client = useHostClientForHostId(hostId);
  const asking = hostId !== null && environmentId !== null;
  const query = useHostQuery<HostRpcRegistry, "environment.previewLocalFacts">({
    // A null host would follow the window's selection; only the computer
    // being claimed is asked.
    client: asking ? client : null,
    method: "environment.previewLocalFacts",
    params: {
      environmentId: environmentId ?? "",
      subject: { kind: "computer" },
    },
    cacheKeyIdentity: undefined,
    options: {
      enabled: asking,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });
  // TanStack keeps the last answer through a failed refetch and hands a
  // cached one to a new observer before it has asked; neither is this open's
  // count.
  if (query.isError || !query.isFetchedAfterMount) return NOT_KNOWN;
  const activeTurns = query.data?.activeTurns ?? null;
  return activeTurns === null
    ? NOT_KNOWN
    : { kind: "counted", chats: activeTurns };
}
