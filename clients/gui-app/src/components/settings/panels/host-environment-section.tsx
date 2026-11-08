/** Docs: see ../SETTINGS.md (Host Overview's settings source). */
import type { ReactNode } from "react";
import {
  HostOverviewSettingsCardSlot,
  type KnownSettingsSource,
} from "@/components/settings/panels/host-overview-settings-card";
import { hostOptionTeamOwner } from "@/components/settings/host-scope/host-option-model";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/** One settings source row, read through the host named by the page. */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
  readonly hostName: string;
}): ReactNode {
  const { scope } = props;
  let fallbackSource: KnownSettingsSource | null = null;
  if (scope.host?.sandbox !== null && scope.host?.sandbox !== undefined) {
    if (!scope.host.sandbox.teamOwned) {
      fallbackSource = { kind: "personal" };
    } else {
      const teamName = hostOptionTeamOwner(scope.host)?.teamName ?? null;
      fallbackSource =
        teamName === null ? null : { kind: "team", name: teamName };
    }
  }
  return (
    <HostOverviewSettingsCardSlot
      client={scope.client}
      hostId={scope.hostId}
      hostName={props.hostName}
      usable={isHostScopeUsable(scope.status) && scope.client !== null}
      fallbackSource={fallbackSource}
    />
  );
}
