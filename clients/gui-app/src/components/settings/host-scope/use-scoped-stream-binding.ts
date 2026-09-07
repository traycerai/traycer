import { useMemo } from "react";
import {
  authenticatedOwnerIdentityKey,
  streamTransportRetain,
  useHostStreamClientBindingFor,
} from "@/hooks/host/use-host-stream-client-for";
import { useHostClient } from "@/lib/host";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { transientClientEntry } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/** A `null` return therefore means "keep using the ambient stream client", and callers that must not read the
 * ambient host say so by refusing to mount the stream at all rather than by rendering its output hidden. */
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
  // Safe to read off `target` only because the key matched: that comparison is what proves this client was built
  // for the target we are naming it with.
  const hostId = matched === null ? null : (target?.hostId ?? null);
  return useMemo(
    () =>
      matched === null
        ? null
        : {
            wsStreamClient: matched.client,
            hostId,
            // This transport IS reference-counted, and this hook holds only the panel's own reference: a consumer that
            // outlives the panel - an import or a migration run started from it - takes its own.
            retain: streamTransportRetain(matched),
          },
    [matched, hostId],
  );
}
