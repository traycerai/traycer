import { useMemo } from "react";
import {
  authenticatedOwnerIdentityKey,
  useHostStreamClientBindingFor,
} from "@/hooks/host/use-host-stream-client-for";
import { useHostClient } from "@/lib/host";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { transientClientEntry } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The STREAMING counterpart of `useScopedHostBinding`: the transport a
 * host-scoped surface re-provides so every `resources.subscribe` /
 * `*.subscribe` session opened beneath it runs against the SELECTED host.
 *
 * It is a second hook rather than one more field on the unary binding because
 * the two seams are genuinely separate — `HostRuntimeContext` carries the
 * request/response client, `StreamRuntimeContext` carries the app-wide
 * `WsStreamClient` — and swapping only the first is how a surface ends up
 * reading host B's RPCs beside host A's live stream. Anything stream-backed
 * (the resource monitor) needs THIS one.
 *
 * The same two guards `useScopedHostBinding` states apply, for the same
 * reasons:
 *
 *   - `status === "ready"` and nothing else. Under `connecting`, `unreachable`
 *     or `vanished` there is no client to dial, and falling back to the ambient
 *     one is host A's processes rendered under host B's name.
 *   - `following` returns null ON PURPOSE (`transientClientEntry`): there the
 *     ambient stream client already IS the scoped host's, so a second transient
 *     transport would open a duplicate socket to the same machine.
 *
 * A `null` return therefore means "keep using the ambient stream client", and
 * callers that must not read the ambient host say so by refusing to mount the
 * stream at all rather than by rendering its output hidden.
 *
 * The third guard is the one the underlying hook cannot apply for us: it holds
 * its binding in state and only replaces it in an EFFECT, so for one commit
 * after a pick it still serves the previous host's client while `scope.hostId`
 * has already moved. Handing that pair on would let a caller open a stream over
 * host B's transport and file it under host C's name. Comparing the binding's
 * own `transportKey` against the identity the current target should produce
 * makes the transport and the name one value: mismatched, there is no client
 * yet.
 */
export function useScopedStreamBinding(
  scope: HostScope,
): StreamRuntimeBinding | null {
  const target =
    scope.status === "ready"
      ? transientClientEntry(scope.host, scope.isViewingActive)
      : null;
  const auth = useStreamAuthRevalidator();
  const ambientClient = useHostClient();
  const binding = useHostStreamClientBindingFor(target, auth);
  const expectedKey = authenticatedOwnerIdentityKey(ambientClient, target);
  const matched =
    binding !== null && binding.transportKey === expectedKey ? binding : null;
  const client = matched === null ? null : matched.client;
  // Safe to read off `target` only BECAUSE the key matched: that comparison is
  // what proves this client was built for the target we are naming it with.
  const hostId = matched === null ? null : (target?.hostId ?? null);
  return useMemo(
    () => (client === null ? null : { wsStreamClient: client, hostId }),
    [client, hostId],
  );
}
