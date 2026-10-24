import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const BROWSER_AGENT_ACCESS = defineSettingsSection(
  "browser-agent-access",
  {
    page: {
      availableWhen: alwaysAvailable,
      label: "Browser agent access",
      description: "Whether your agents can use Traycer's in-app browser.",
      keywords: ["agent", "browser", "playwright", "mcp", "web"],
    },
    access: {
      kind: "group",
      search: { contributesTo: "page" },
      label: "Access",
      description: null,
      breadcrumb: null,
      availableWhen: alwaysAvailable,
      keywords: [],
    },
    // Its rendered sentence names the host it was read from, so that sentence
    // is a `status` and this static copy is what search reads.
    agentBrowserAccess: {
      kind: "row",
      group: "access",
      search: { contributesTo: "page" },
      label: "Let agents use the in-app browser",
      description:
        "Agents get Traycer's browser as a tool and are told to use it for web pages. Turn off to let them use their own browser tooling.",
      availableWhen: alwaysAvailable,
      keywords: ["agent", "browser", "playwright", "mcp"],
    },
  },
);
