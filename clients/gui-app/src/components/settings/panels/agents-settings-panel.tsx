/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSelectionGuideSection } from "./agent-selection-guide-section";

// The global agent selection guide lives in its own full-height settings
// section so the Markdown source editor can use all remaining panel space.
export function AgentsSettingsPanel() {
  return (
    <SettingsPanelShell title="Agents" fillHeight>
      <AgentSelectionGuideSection />
    </SettingsPanelShell>
  );
}
