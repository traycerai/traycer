import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const AGENT_SELECTION = defineSettingsSection("agents", {
  page: {
    availableWhen: alwaysAvailable,
    // As before environments, which brought the Definitions tab, in a build
    // without them (`unreleased-features.ts`).
    label: UNRELEASED_FEATURES_ENABLED ? "Agents" : "Agent selection",
    description: UNRELEASED_FEATURES_ENABLED
      ? "How agents are picked, and the agents each coding agent can start."
      : "How Traycer picks a coding agent, model, and reasoning effort when it spawns child agents.",
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
      ...(UNRELEASED_FEATURES_ENABLED
        ? ["agent definition", "subagent", "agents.md", "custom agent"]
        : []),
    ],
  },
});
