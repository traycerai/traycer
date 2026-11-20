import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { hostRunsPersonal } from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * Whether the window's host runs Personal; `null` while it is unknown: no
 * handshake yet, or a host that serves `environment.status` and has not
 * answered. A window with no host runs nothing, and neither does one whose
 * host cannot be reached: its pages read the cloud rather than wait for a
 * handshake that cannot happen.
 */
export function useWindowHostRunsPersonal(): boolean | null {
  const scope = usePersonalHostScope();
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const version = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.status",
  );
  if (scope.hostId === null) return false;
  if (scope.status === "unreachable" || scope.status === "vanished")
    return false;
  if (version === null) return null;
  if (version !== false && status.data === null && !status.isError) {
    return null;
  }
  return hostRunsPersonal(
    { hostId: scope.hostId, name: scope.hostLabel },
    status.data,
    version,
  );
}
