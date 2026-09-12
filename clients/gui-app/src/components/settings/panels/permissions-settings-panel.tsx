/**
 * Docs: see ../SETTINGS.md (Permissions).
 * Update that file whenever this settings surface changes.
 */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { AutoModeSettingsSection } from "./auto-mode-settings-section";

// What an agent may do on this machine without asking. Its own page, not rows
// on Agent selection: that page is about which agent gets CHOSEN for a task,
// and who reviews what the chosen agent then does is a different question,
// asked by a different person at a different time.
//
// Everything here is host-scoped - the judge is stored per machine, and the
// policy and shipped rules are read through that machine's host - which is why
// the page sits under the sidebar's host picker and behind the same gate every
// host page uses. The app-wide DEFAULT permission mode is deliberately NOT
// here: it is one preference for this app, not per machine, so it lives in
// General (SETTINGS.md, "Scope: the organising idea"). The per-provider switch
// between Traycer's judge and a provider's own classifier is not here either;
// it is a fact about one provider's CLI and lives on that provider's own
// Permissions tab under Providers (every provider has the tab; only one with
// a classifier of its own has the switch), which is the switch that wins.
export function PermissionsSettingsPanel() {
  const scope = useHostScope();
  return (
    <SettingsPanelShell
      title="Permissions"
      description="Who reviews what an agent does on this machine under the Auto permission mode: the judge Traycer runs, the policy it follows, and the rules that always apply."
    >
      <HostScopeGate
        scope={scope}
        skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
      >
        <AutoModeSettingsSection />
      </HostScopeGate>
    </SettingsPanelShell>
  );
}
