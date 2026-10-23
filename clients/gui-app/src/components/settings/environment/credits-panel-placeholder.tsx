import type { ReactNode } from "react";
import { CREDITS_PAGE } from "@/components/settings/environment/credits-page-placeholder";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";

/**
 * PLACEHOLDER (E4 removes it for E8's export): Settings ▸ Account ▸ Credits. Once E8's
 * `CreditsSettingsPanel` (`panels/credits-settings-panel.tsx`) is on the
 * branch this file re-exports it and nothing else.
 */
export function CreditsSettingsPanel(): ReactNode {
  return (
    <SettingsPanelShell
      title={CREDITS_PAGE.label}
      description={CREDITS_PAGE.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {null}
    </SettingsPanelShell>
  );
}
