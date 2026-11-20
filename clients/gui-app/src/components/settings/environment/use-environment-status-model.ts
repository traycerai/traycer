import { useMemo } from "react";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  environmentPickerModel,
  isEnvironmentComputer,
  type EnvironmentPickerModel,
} from "@/components/settings/environment/environment-picker-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useRegisteredHostEnvironmentStatuses } from "@/hooks/environment/use-registered-host-environment-statuses";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * The Environment dropdown's model and the `environment.status` of each
 * computer it reads (`isEnvironmentComputer`).
 */
export function useEnvironmentStatusModel(scope: HostScope): {
  readonly picker: EnvironmentPickerModel;
  readonly statuses: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>;
} {
  const hosts = useMemo(
    () => scope.hosts.filter(isEnvironmentComputer),
    [scope.hosts],
  );
  const hostIds = useMemo(() => hosts.map((host) => host.hostId), [hosts]);
  const statuses = useRegisteredHostEnvironmentStatuses(hosts);
  const versions = useHostNegotiatedMethodVersions(
    hostIds,
    "environment.status",
  );
  const windowHost = scope.hosts.find(
    (host) => host.hostId === scope.activeHostId,
  );
  // A listed sandbox has no own-settings row; an unlisted host is still unknown.
  const windowHostId =
    windowHost !== undefined && windowHost.sandbox !== null
      ? null
      : scope.activeHostId;
  const picker = useMemo(
    () =>
      environmentPickerModel({
        hosts,
        statuses,
        versions,
        windowHostId,
      }),
    [hosts, statuses, versions, windowHostId],
  );
  return { picker, statuses };
}
