import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Probes a candidate binary path for executability + version readout
 * without committing it as the override. Used by the Settings → Providers
 * panel to show "v0.20.1 (detected)" inline while the user is typing a
 * custom path.
 *
 * Disabled (`enabled: false`) until the candidate path is non-empty so we
 * don't spawn `<bin> --version` on every keystroke against an empty
 * string. Callers should debounce the path value before binding it here.
 */
export function useProvidersDetectVersion(args: {
  readonly candidatePath: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.detectVersion">,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "providers.detectVersion">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.detectVersion",
    params: { candidatePath: args.candidatePath },
    options: { enabled: args.enabled && args.candidatePath.length > 0 },
  });
}
