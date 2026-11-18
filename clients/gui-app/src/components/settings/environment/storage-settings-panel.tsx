import type { ReactNode } from "react";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import { StoragePolicySection } from "@/components/settings/panels/storage-policy-section";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Settings ▸ Environment ▸ Storage: what the picked configuration's hosts keep
 * on disk. On a Local row the page is the move's offer instead
 * (`LocalMovePageOr`), so the policy only ever reads Personal or a team.
 */
export function StorageSettingsPanel(): ReactNode {
  const pick = useEnvironmentPick();
  return (
    <SettingsPanelShell
      title={STORAGE.page.label}
      description={STORAGE.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {pick.kind === "local" ? null : <StoragePolicySection pick={pick} />}
    </SettingsPanelShell>
  );
}
