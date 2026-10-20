import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const AGENT_DEFINITIONS = defineSettingsSection("agent-definitions", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Agent definitions",
    description:
      "Agent definition files every host you use gets, for coding agents that read them.",
    keywords: ["agent definition", "subagent", "agents.md", "custom agent"],
  },
});
