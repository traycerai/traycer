/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSelectionGuideSection } from "./agent-selection-guide-section";
import { AutoModeSettingsSection } from "./auto-mode-settings-section";

// The global agent selection guide lives in its own full-height settings
// section so the Markdown source editor can use all remaining panel space.
//
// Titled "Agent selection" rather than "Agents": the page configures how a
// coding agent and model are CHOSEN when spawning child agents. The
// description says so explicitly, because "Agents" read as a manager for the
// Agents inside a Task - a different surface entirely.
//
// The Auto-mode rows sit above it because they belong to the same machine the
// sidebar's picker names (the judge is stored per host) and to the same
// question: which agent Traycer reaches for on your behalf. They contribute
// nothing to the panel's height - the guide editor still owns everything the
// rows do not need - and they render nothing at all on a host that has no
// notion of auto mode, which is every host until it updates.
//
// The APP-WIDE default permission mode is deliberately NOT here: it is one
// preference for this app, not per machine, so it lives in General (SETTINGS.md,
// "Scope: the organising idea"). This page holds the judge that mode uses.
export function AgentsSettingsPanel() {
  return (
    <SettingsPanelShell
      title="Agent selection"
      description="How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents - and the judge that reviews actions in Auto mode on this machine. This does not manage the agents inside a Task."
      fillHeight
      bodyClassName="flex flex-col"
    >
      <AutoModeSettingsSection />
      <div className="min-h-0 flex-1">
        <AgentSelectionGuideSection />
      </div>
    </SettingsPanelShell>
  );
}
