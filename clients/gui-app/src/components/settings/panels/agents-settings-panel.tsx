/** Docs: see../settings.md Update that file whenever this settings surface changes. */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSelectionGuideSection } from "./agent-selection-guide-section";

// Titled "Agent selection" rather than "Agents": the page configures how a coding agent and model are chosen
// when spawning child agents.
export function AgentsSettingsPanel() {
  return (
    <SettingsPanelShell
      title="Agent selection"
      description="How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents. This does not manage the agents inside a Task."
      fillHeight
    >
      <AgentSelectionGuideSection />
    </SettingsPanelShell>
  );
}
