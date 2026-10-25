import { useMemo } from "react";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import {
  environmentPickerModel,
  isEnvironmentComputer,
  type EnvironmentPickerHost,
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
  const picker = useMemo(
    () =>
      environmentPickerModel({
        hosts,
        statuses,
        versions,
        windowHostId: scope.activeHostId,
      }),
    [hosts, statuses, versions, scope.activeHostId],
  );
  return { picker, statuses };
}

/**
 * The computers running Personal, from the same reads the dropdown makes;
 * the move sheet names them as where the moved settings reach.
 */
export function useHostsRunningPersonal(
  scope: HostScope,
): readonly EnvironmentPickerHost[] {
  return useEnvironmentStatusModel(scope).picker.runningPersonal;
}
