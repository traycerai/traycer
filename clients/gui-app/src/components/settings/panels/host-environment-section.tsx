/** Docs: see ../SETTINGS.md (Host Overview's settings source). */
import type { ReactNode } from "react";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import { hostOptionTeamOwner } from "@/components/settings/host-scope/host-option-model";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/** One settings source row, read through the host named by the page. */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
  readonly hostName: string;
}): ReactNode {
  const { scope } = props;
  let fallbackSource: string | null = null;
  if (scope.host?.sandbox !== null && scope.host?.sandbox !== undefined) {
    fallbackSource = scope.host.sandbox.teamOwned
      ? (hostOptionTeamOwner(scope.host)?.teamName ?? null)
      : "Personal";
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
