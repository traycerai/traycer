/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSelectionGuideSection } from "./agent-selection-guide-section";

// The global agent selection guide lives in its own full-height settings
// section so the Markdown source editor can use all remaining panel space.
//
// Titled "Agent selection" rather than "Agents": the page configures how a
// coding agent and model are CHOSEN when spawning child agents. The
// description says so explicitly, because "Agents" read as a manager for the
// Agents inside a Task - a different surface entirely.
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
