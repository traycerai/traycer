import { use, useMemo } from "react";
import {
  authenticatedOwnerIdentityKey,
  streamTransportRetain,
  useHostStreamClientBindingFor,
} from "@/hooks/host/use-host-stream-client-for";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClient } from "@/lib/host";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  StreamRuntimeContext,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";

/** null is pending, never ambient-fallback. Hand on only when transportKey names resolvedHostId. */
export function useSurfaceHostStreamBinding(
  resolvedHostId: string | null,
): StreamRuntimeBinding | null {
  const effectiveHostId = useEffectiveHostId();
  const ambientStream = use(StreamRuntimeContext);
  const isFollowing =
    resolvedHostId === null || resolvedHostId === effectiveHostId;
  const entry = useHostDirectoryEntryForHostId(
    isFollowing ? null : resolvedHostId,
  );
  const auth = useStreamAuthRevalidator();
  const ambientClient = useHostClient();
  const binding = useHostStreamClientBindingFor(entry, auth);
  const expectedKey = authenticatedOwnerIdentityKey(ambientClient, entry);
  const matched =
    binding !== null && binding.transportKey === expectedKey ? binding : null;
  // Safe to read off `entry` only BECAUSE the key matched: that comparison is
  // what proves this client was built for the target we are naming it with.
  const hostId = matched === null ? null : (entry?.hostId ?? null);
  const pinned = useMemo(
    () =>
      matched === null
        ? null
        : {
            wsStreamClient: matched.client,
            hostId,
            // Reference-counted, and this hook holds only the surface's own
            // reference: anything that outlives the surface takes its own.
            retain: streamTransportRetain(matched),
          },
    [matched, hostId],
  );
  if (!isFollowing) return pinned;
  // `effectiveHostId` IS the resolved host on this branch (`resolvedHostId` is null or equal to it), so the comparison is against the one value both readings must agree on.
  return ambientStream !== null && ambientStream.hostId === effectiveHostId
    ? ambientStream
    : null;
}
