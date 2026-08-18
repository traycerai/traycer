import { use, useMemo } from "react";
import {
  authenticatedOwnerIdentityKey,
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
 * FOLLOWING RETURNS THE AMBIENT BINDING - resolved here, not by the caller.
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
 *
 * NULL MEANS PENDING, NOT "USE THE AMBIENT ONE". The value returned is the
 * one to PROVIDE: the ambient binding while following, the pinned host's own
 * binding once it is built and named, and `null` in between - for the commit
 * after a pin lands or moves, before the underlying hook's effect has built
 * (or re-keyed) the client. Callers used to write `pinned ?? ambient`, which
 * folded that pending commit into "following": children's subscription
 * effects run before this ancestor's build effect, so a git-diff tile pinned
 * to host B dispatched `git.subscribeStatus` for B's path over host A's
 * socket for one commit on every mount, and A started a watcher on a path
 * that commonly exists on both machines. `useWsStreamClient()` reads a null
 * context as "no client" and its subscriptions wait, which is the honest
 * state; the ambient socket is only the answer when the pin resolves TO the
 * ambient host.
 *
 * THE FOLLOWING BRANCH IS FENCED THE SAME WAY. `HostStreamProvider` holds its
 * binding in state and replaces it in a passive effect too, so for the commit
 * after the effective host moves A -> B it still serves A's client under A's
 * name while `useEffectiveHostId()` already answers B. A surface pinned to B
 * flips to `isFollowing` on that same commit, and handing it the ambient
 * binding there would move it OFF its own correctly-built B stream and onto
 * A's socket for one commit - the exact shape the pinned branch refuses. So
 * the ambient binding is only handed on once it NAMES the host this surface
 * resolves to; until then the surface is pending, as it is for its own pin.
 */
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
  const client = matched === null ? null : matched.client;
  // Safe to read off `entry` only BECAUSE the key matched: that comparison is
  // what proves this client was built for the target we are naming it with.
  const hostId = matched === null ? null : (entry?.hostId ?? null);
  const pinned = useMemo(
    () => (client === null ? null : { wsStreamClient: client, hostId }),
    [client, hostId],
  );
  if (!isFollowing) return pinned;
  // Following: the ambient binding, once it names the host this surface
  // resolves to. `effectiveHostId` IS the resolved host on this branch
  // (`resolvedHostId` is null or equal to it), so the comparison is against
  // the one value both readings must agree on.
  return ambientStream !== null && ambientStream.hostId === effectiveHostId
    ? ambientStream
    : null;
}
