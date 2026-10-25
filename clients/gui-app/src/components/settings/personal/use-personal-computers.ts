import { useMemo } from "react";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import { useRegisteredHostEnvironmentStatuses } from "@/hooks/environment/use-registered-host-environment-statuses";
import {
  isEnvironmentComputer,
  hostRunsPersonal,
} from "@/components/settings/environment/environment-picker-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * The computers running Personal, as the page chip counts them: the person's
 * computers (no sandbox) whose own status names Personal and that are not a
 * Local row. Each holds a copy of Personal's values. None is read while
 * `enabled` is false.
 */
export interface PersonalComputers {
  readonly computers: readonly HostScopeOption[];
  readonly statuses: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>;
  readonly versions: ReadonlyMap<string, NegotiatedMethodVersion>;
  readonly participants: readonly HostScopeOption[];
}

export function usePersonalComputers(enabled: boolean): PersonalComputers {
  const scope = useHostScope();
  const computers = useMemo(
    () => (enabled ? scope.hosts.filter(isEnvironmentComputer) : []),
    [enabled, scope.hosts],
  );
  const hostIds = useMemo(
    () => computers.map((host) => host.hostId),
    [computers],
  );
  const statuses = useRegisteredHostEnvironmentStatuses(computers);
  const versions = useHostNegotiatedMethodVersions(
    hostIds,
    "environment.status",
  );
  const participants = computers.filter((host) =>
    hostRunsPersonal(
      host,
      statuses.get(host.hostId) ?? null,
      versions.get(host.hostId) ?? null,
    ),
  );
  return { computers, statuses, versions, participants };
}
