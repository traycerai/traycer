import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const AGENT_SELECTION = defineSettingsSection("agents", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Agents",
    description: "How agents are picked, and the agents a harness can start.",
    keywords: [
      "agents",
      "guide",
      "instructions",
      "model",
      "reasoning",
      "effort",
      "delegation",
      "child agent",
      "routing",
      "agent definition",
      "subagent",
      "agents.md",
      "custom agent",
    ],
  },
});
