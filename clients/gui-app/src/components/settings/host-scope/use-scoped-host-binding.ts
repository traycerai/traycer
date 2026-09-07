import { useMemo } from "react";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/** Runtime binding for the host this surface is showing. Set `hostId` explicitly (the ambient spread's `null`
 * would compile). Do not wrap a composer. */
export function useScopedHostBinding(
  scope: HostScope,
): HostRuntimeBinding<HostRpcRegistry> | null {
  const realBinding = useHostBinding();
  return useMemo(() => {
    if (realBinding === null) return null;
    // `scope.client` is already null for `connecting`/`unreachable`/`vanished`, but that is a guarantee made
    // upstream.
    if (scope.status !== "ready" && scope.status !== "following") return null;
    if (scope.client === null) return null;
    // Naming `scope.hostId` here would pin the panel to whichever host was effective when it mounted -
    // auto-follow, silently deleted.
    if (scope.status === "following") {
      return { ...realBinding, hostClient: scope.client, hostId: null };
    }
    // `ready` guarantees a host: `deriveHostScopeStatus` returns before `ready`
    // whenever `host === null`, and `scope.hostId` is `host?.hostId`.
    return { ...realBinding, hostClient: scope.client, hostId: scope.hostId };
  }, [scope.status, scope.hostId, scope.client, realBinding]);
}
