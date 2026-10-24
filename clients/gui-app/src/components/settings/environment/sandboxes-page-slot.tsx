import type { ReactNode } from "react";
import { AutomationsHostEntry } from "@/components/hosts/automations-host-entry";
import { SandboxBalanceBanner } from "@/components/hosts/sandbox-balance-banner";
import { SANDBOXES } from "@/components/settings/environment/sandboxes-page.definitions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";

/**
 * SLOT (seam 1: the sandboxes plan mounts its page here): Settings ▸
 * Environment ▸ Sandboxes, the `sandboxes` page of the registry in
 * `lib/settings-environment-pages.ts`. Until their page lands it shows the
 * sandbox surface the Host picker already carries, unchanged.
 */
export function SandboxesSettingsPanel(): ReactNode {
  return (
    <SettingsPanelShell
      title={SANDBOXES.page.label}
      description={SANDBOXES.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className="flex flex-col gap-2" data-testid="sandboxes-page-slot">
        <AutomationsHostEntry />
        <SandboxBalanceBanner />
      </div>
    </SettingsPanelShell>
  );
}
