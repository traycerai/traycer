import { useMemo } from "react";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The runtime binding a host-scoped panel re-provides so every hook beneath it
 * targets the SELECTED host rather than the ambient one.
 *
 * Two guards, both load-bearing (the Providers panel proved each of them the
 * hard way — `providers-settings-panel.tsx`):
 *
 *   - `status === "ready"` and nothing else. `connecting`, `unreachable` and
 *     `vanished` all leave `client` null, and re-providing a null client would
 *     make `useHostClient()` throw; falling back to the ambient client instead
 *     is worse still — that is one host's data rendered under another host's
 *     name, the exact substitution the scope model exists to prevent.
 *   - `following` returns null ON PURPOSE. There the ambient binding already IS
 *     the scoped host's, so re-providing a copy would duplicate the context for
 *     no gain and detach the subtree from binding updates.
 */
export function useScopedHostBinding(
  scope: HostScope,
): HostRuntimeBinding<HostRpcRegistry> | null {
  const realBinding = useHostBinding();
  return useMemo(() => {
    if (scope.status !== "ready" || scope.client === null) return null;
    if (realBinding === null) return null;
    return { ...realBinding, hostClient: scope.client };
  }, [scope.status, scope.client, realBinding]);
}
