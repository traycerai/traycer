import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const AGENT_SELECTION = defineSettingsSection("agents", {
  page: {
    label: "Agent selection",
    description:
      "How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents.",
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
    ],
  },
});
