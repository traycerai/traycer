/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
import { EnvironmentHostBinding } from "@/components/settings/environment/environment-host-binding";
import { AGENT_SELECTION } from "@/components/settings/panels/agents-settings.definitions";
import { AgentDefinitionsTab } from "@/components/settings/panels/agent-definitions-tab";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentSelectionGuideSection } from "./agent-selection-guide-section";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

type AgentsTab = "guide" | "definitions";
const AGENTS_TABS: ReadonlyArray<AgentsTab> = ["guide", "definitions"];

const AGENTS_TAB_LABELS: Readonly<Record<AgentsTab, string>> = {
  guide: "Selection guide",
  definitions: "Definitions",
};

// The guide reaches only the agents Traycer creates; a coding agent's own
// native subagents never read it (traycerai/traycer#1090).
const AGENTS_GUIDE_CAPTION =
  "The guide agents read when they pick a coding agent, model and effort for work they hand off.";

// The page's own header before environments: the page was the guide alone.
const AGENTS_PAGE_DESCRIPTION = UNRELEASED_FEATURES_ENABLED
  ? AGENT_SELECTION.page.description
  : "How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents. This does not manage the agents inside a Task.";

function isAgentsTab(value: string): value is AgentsTab {
  return AGENTS_TABS.some((tab) => tab === value);
}

/**
 * Settings ▸ Agents: two tabs over the configuration's room files. Selection
 * guide is the markdown guide agents read to pick a harness, model and effort,
 * and keeps the full panel height for its editor; Definitions is one file per
 * agent definition a harness can start.
 */
export function AgentsSettingsPanel(): ReactNode {
  const [tab, setTab] = useState<AgentsTab>("guide");
  // Definitions are a configuration's files (environments): a build without
  // them (`unreleased-features.ts`) has the guide alone, drawn as the page
  // with no tab strip and no caption, as before them.
  if (!UNRELEASED_FEATURES_ENABLED) {
    return (
      <SettingsPanelShell
        title={AGENT_SELECTION.page.label}
        description={AGENTS_PAGE_DESCRIPTION}
        fillHeight
      >
        <AgentSelectionGuideSection />
      </SettingsPanelShell>
    );
  }
  return (
    <SettingsPanelShell
      title={AGENT_SELECTION.page.label}
      description={AGENTS_PAGE_DESCRIPTION}
      fillHeight
    >
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (isAgentsTab(next)) setTab(next);
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList
          variant="line"
          className="h-auto w-full max-w-full shrink-0 flex-wrap justify-start"
        >
          {AGENTS_TABS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              className="flex-none"
              data-testid={`agents-tab-${value}`}
            >
              {AGENTS_TAB_LABELS[value]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent
          value="guide"
          className="flex min-h-0 flex-1 flex-col gap-3 pt-5"
        >
          <p
            className="text-ui-xs text-muted-foreground"
            data-testid="agents-guide-caption"
          >
            {AGENTS_GUIDE_CAPTION}
          </p>
          <AgentSelectionGuideSection />
        </TabsContent>
        <TabsContent value="definitions" className="pt-5">
          {/* Definitions read the ambient binding, so a Local row's pick
              re-provides it to that computer. */}
          <EnvironmentHostBinding>
            <AgentDefinitionsTab />
          </EnvironmentHostBinding>
        </TabsContent>
      </Tabs>
    </SettingsPanelShell>
  );
}
