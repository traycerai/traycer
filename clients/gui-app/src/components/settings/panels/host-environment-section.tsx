import { useHostCredentialStatus } from "@/hooks/host/use-host-credential-status";
import { useHostOwnership } from "@/hooks/auth/use-host-ownership";
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
  const credentialStatus = useHostCredentialStatus(scope.hostId);
  const local = scope.host?.isLocalMachine ?? false;
  const ownership = useHostOwnership(scope.hostId, local);
  const owner = local
    ? (ownership.data?.owner ?? null)
    : (scope.host?.item?.owner ?? null);
  return (
    <>
      {credentialStatus === "team-unavailable" && owner?.kind !== "user" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          This computer can't work for the team right now.
        </p>
      ) : null}
      <HostOverviewSettingsCardSlot
        client={scope.client}
        hostId={scope.hostId}
        hostName={props.hostName}
        owner={owner}
        isLocalMachine={scope.host?.isLocalMachine ?? false}
        usable={isHostScopeUsable(scope.status) && scope.client !== null}
      />
    </>
  );
}
