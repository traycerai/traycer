import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const AGENT_MEMORIES = defineSettingsSection("agent-memories", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Agent memories",
    description: "What your agents carry from one task to the next.",
    keywords: ["memory", "memories", "remember", "facts", "context", "agent"],
  },
  memories: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Agent memories",
    description:
      "Carry useful facts and preferences from one task to the next.",
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  // Its rendered sentence changes with the switch and with the scope it was
  // read at, so that sentence is a `status` and this static copy is what
  // search reads.
  traycerMemories: {
    kind: "row",
    group: "memories",
    search: { contributesTo: "page" },
    label: "Use Traycer memories for agents",
    description:
      "Agents receive shared memories in context and can keep them up to date. Turning this off keeps saved memories.",
    availableWhen: alwaysAvailable,
    keywords: ["memory", "memories", "shared", "remember"],
  },
});
