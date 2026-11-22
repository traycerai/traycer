import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { hostRunsPersonal } from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * Whether the window's host runs Personal, read through `scope`, the window's
 * own host scope; `null` while it is unknown: no handshake yet, or a host that
 * serves `environment.status` and has not answered. A window with no host
 * runs nothing, and neither does one whose host cannot be reached or is
 * offline now, whatever it answered before it stopped: its pages read the
 * cloud rather than ask a host that is not there. A host still connecting or
 * restarting is not offline, so it stays unknown and its row does not flicker.
 */
export function useWindowHostRunsPersonal(scope: HostScope): boolean | null {
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const version = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.status",
  );
  if (scope.hostId === null) return false;
  if (
    scope.status === "unreachable" ||
    scope.status === "vanished" ||
    scope.host?.health.state === "offline"
  )
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
