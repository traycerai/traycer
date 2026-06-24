/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSelectionGuideSection } from "./agent-selection-guide-section";

// The global agent selection guide lives in its own settings section. The
// editor itself is shared with no other surface, so the panel is just the
// section wrapped in the standard settings shell.
export function AgentsSettingsPanel() {
  return (
    <SettingsPanelShell title="Agents">
      <AgentSelectionGuideSection />
    </SettingsPanelShell>
  );
}
