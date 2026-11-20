import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { hostRunsPersonal } from "@/components/settings/environment/environment-picker-model";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * What the window's host says about Personal, read through `scope`, the
 * window's own host scope.
 *
 * `runs`: whether that host runs Personal; `null` while it is unknown: no
 * handshake yet, or a host that serves `environment.status` and has not
 * answered. A window with no host runs nothing, and neither does one whose
 * host cannot be reached: its pages read the cloud rather than wait for a
 * handshake that cannot happen.
 *
 * `outage`: the window has a host and that host cannot be reached, or its
 * `environment.status` read failed, so `runs` is the cloud fallback rather
 * than the host's answer.
 */
export interface WindowHostPersonal {
  readonly runs: boolean | null;
  readonly outage: boolean;
}

export function useWindowHostPersonal(scope: HostScope): WindowHostPersonal {
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const version = useHostNegotiatedMethodVersion(
    scope.client,
    "environment.status",
  );
  if (scope.hostId === null) return { runs: false, outage: false };
  if (scope.status === "unreachable" || scope.status === "vanished")
    return { runs: false, outage: true };
  if (version === null) return { runs: null, outage: false };
  if (version !== false && status.data === null && !status.isError) {
    return { runs: null, outage: false };
  }
  return {
    runs: hostRunsPersonal(
      { hostId: scope.hostId, name: scope.hostLabel },
      status.data,
      version,
    ),
    outage: version !== false && status.isError,
  };
}
