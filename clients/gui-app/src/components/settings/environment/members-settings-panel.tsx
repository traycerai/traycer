import { TeamComputersSection } from "@/components/settings/team/team-computers-section";
import type { ReactNode } from "react";
import { MembersPage } from "@/components/settings/members/members-page";
import { MEMBERS } from "@/components/settings/environment/members-page.definitions";
import { HostScopeNotice } from "@/components/settings/host-scope/host-scope-gate";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Settings ▸ Environment ▸ Members: the picked team's members.
 * The row is offered only under a team; any other pick that lands here, by
 * a remembered path or a pick made on this page, is told so in place.
 */
export function MembersSettingsPanel(): ReactNode {
  const pick = useEnvironmentPick();
  // No shell subtitle on a team: MembersView's own header line names the
  // team, and a second, generic one above it only repeats it.
  return (
    <SettingsPanelShell
      title={MEMBERS.page.label}
      description={pick.kind === "team" ? undefined : MEMBERS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {pick.kind === "team" ? (
        <>
          <MembersPage environmentId={pick.environmentId} />
          <TeamComputersSection environmentId={pick.environmentId} />
        </>
      ) : (
        <HostScopeNotice
          tone="idle"
          title="Only a team has members"
          detail={null}
          action={null}
          testId="members-team-only"
        />
      )}
    </SettingsPanelShell>
  );
}
