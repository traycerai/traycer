import type { ReactNode } from "react";
import { BROWSER_AGENT_ACCESS } from "@/components/settings/panels/browser-agent-access.definitions";
import { PermissionsBrowserAgentAccess } from "@/components/settings/panels/permissions-settings-panel";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";

/**
 * The legacy Browser agent access page, where a remembered section or an old
 * link still lands: the same switch as Permissions' Browser tab, under the
 * section's own heading, so the address, the heading and the crumb agree. It
 * opens in place under every pick; a computer without it says so in its body
 * (`PageOrNotOnComputer`). Navigation and search offer Permissions instead.
 */
export function BrowserAgentAccessSettingsPanel(): ReactNode {
  return (
    <SettingsPanelShell
      title={BROWSER_AGENT_ACCESS.page.label}
      description={BROWSER_AGENT_ACCESS.page.description}
      bodyClassName="flex flex-col gap-3 overflow-visible rounded-none border-none bg-transparent"
    >
      <PermissionsBrowserAgentAccess />
    </SettingsPanelShell>
  );
}
