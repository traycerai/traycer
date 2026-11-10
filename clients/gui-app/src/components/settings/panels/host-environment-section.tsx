/** Docs: see ../SETTINGS.md (Host Overview's settings source). */
import type { ReactNode } from "react";
import { HostOverviewSettingsCardSlot } from "@/components/settings/panels/host-overview-settings-card";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * One Environment row, read through the host named by the page.
 *
 * A failed read shows nothing. The row does not guess Personal or a team
 * from sandbox ownership: that binding is not this read.
 */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
  readonly hostName: string;
}): ReactNode {
  const { scope } = props;
  return (
    <HostOverviewSettingsCardSlot
      client={scope.client}
      hostId={scope.hostId}
      hostName={props.hostName}
      owner={scope.host?.item?.owner ?? null}
      isLocalMachine={scope.host?.isLocalMachine ?? false}
      usable={isHostScopeUsable(scope.status) && scope.client !== null}
    />
  );
}
