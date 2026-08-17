import { useMemo } from "react";
import {
  authenticatedOwnerIdentityKey,
  useHostStreamClientBindingFor,
} from "@/hooks/host/use-host-stream-client-for";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClient } from "@/lib/host";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";

/**
 * The STREAM transport for a surface PIN, to be re-provided as that surface's
 * `StreamRuntimeContext`.
 *
 * The pin's unary half is one line - `useSurfaceHostClient` is
 * `useHostClientForHostId` - because every unary consumer already takes a
 * client or a host id. The stream half cannot be, because the stream
 * consumers do NOT: `useGitListChangedFilesSubscription`,
 * `useWorkspaceFileListSubscription` and the PR ones all read
 * `useWsStreamClient()` out of context. So the surface moves its transport by
 * re-providing the context, exactly as `resource-monitor-popover` already
 * does through `useScopedStreamBinding` - this is that hook for a pin rather
 * than a `HostScope`.
 *
 * WHAT THE DEFECT LOOKED LIKE, because it did not look like an error. Those
 * subscription hooks take a `hostId` PARAM as well, and the pinned surfaces
 * were already passing the pin's host into it. So the subscribe carried host
 * B's name and rode host A's socket: a shape that renders, populates, and
 * watches the wrong machine's filesystem. Nothing throws, because the param
 * is a key, not a route.
 *
 * FOLLOWING RETURNS NULL, and the caller falls back to the ambient binding.
 * This is not just the "don't open a second socket to the same machine" rule
 * `useScopedStreamBinding` states - here it also decides SHARING. The app-wide
 * `HostStreamProvider` calls `buildHostStreamClient` directly rather than
 * through the per-host cache, so a surface that built its own client for the
 * host it is already following would hold a DIFFERENT object than every other
 * app-wide consumer, and the shared-subscription registries key on
 * `client.instanceId`. It would split one `git.subscribeStatus` into two
 * against the same host - the exact waste the cache exists to prevent, arrived
 * at from the other side.
 *
 * The transport-key guard is the third one, and the underlying hook cannot
 * apply it for us: it holds its binding in state and only replaces it in an
 * EFFECT, so for one commit after the pin moves it still serves the previous
 * host's client while `resolvedHostId` has already changed. Handing that pair
 * on would let a surface open a stream over host B's transport and file it
 * under host C's name. Comparing the binding's own `transportKey` against the
 * identity the current target should produce makes the transport and its name
 * one value: mismatched, there is no client yet.
 */
export function useSurfaceHostStreamBinding(
  resolvedHostId: string | null,
): StreamRuntimeBinding | null {
  const effectiveHostId = useEffectiveHostId();
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
  const client = matched === null ? null : matched.client;
  // Safe to read off `entry` only BECAUSE the key matched: that comparison is
  // what proves this client was built for the target we are naming it with.
  const hostId = matched === null ? null : (entry?.hostId ?? null);
  return useMemo(
    () => (client === null ? null : { wsStreamClient: client, hostId }),
    [client, hostId],
  );
}
