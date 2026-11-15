import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import type { HostRpcRegistry } from "@/lib/host";

/** Only the surface's computer can identify the environment whose rows it lists. */
export function useProfileRecordEnvironmentId(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): string | null {
  const status = useHostNegotiatedMethodVersion(client, "environment.status");
  const hostId = useRequesterHostId(client);
  const bindingReadable =
    useHostMethodSupport(hostId, "environment.host.read") === true;
  const usable =
    enabled && status !== null && status !== false && bindingReadable;
  const binding = useEnvironmentHostReadQuery(client, hostId, usable);
  return usable && binding.kind === "binding" && !binding.query.isError
    ? (binding.query.data?.environment.environmentId ?? null)
    : null;
}
