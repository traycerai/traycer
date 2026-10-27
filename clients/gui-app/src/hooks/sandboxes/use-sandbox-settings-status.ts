import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { sandboxSettingsReady } from "@traycer/protocol/host/sandbox-settings";

/** A read of an awake host never wakes it. Older hosts keep their existing guest-configuration evidence. */
export function useSandboxSettingsStatus(
  hostId: string | null,
  enabled: boolean,
) {
  const client = useHostClientForHostId(hostId);
  const supported = useHostMethodSupport(hostId, "environment.status");
  const query = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: {
      enabled: enabled && hostId !== null && supported === true,
      poll: true,
    },
  });
  const ready =
    supported === false ||
    (supported === true &&
      query.data !== undefined &&
      query.data.receivedRevision !== null &&
      sandboxSettingsReady(query.data.items));
  return { ...query, ready };
}
