import type { ReactNode } from "react";
import { MembersPage } from "@/components/settings/members/members-page";
import { MEMBERS } from "@/components/settings/environment/members-page.definitions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Settings ▸ Environment ▸ Members: the picked team's members (P2's page).
 * The row is offered only under a team; a remembered path under Personal
 * shows the page with nothing in it.
 */
export function MembersSettingsPanel(): ReactNode {
  const pick = useEnvironmentPick();
  return (
    <SettingsPanelShell
      title={MEMBERS.page.label}
      description={MEMBERS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {pick.kind === "team" ? (
        <MembersPage environmentId={pick.environmentId} />
      ) : null}
    </SettingsPanelShell>
  );
}
