import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const MCP_SERVERS = defineSettingsSection("mcp-servers", {
  page: {
    availableWhen: alwaysAvailable,
    label: "MCP servers",
    description: "The MCP servers each coding agent can use.",
    keywords: [
      "mcp",
      "model context protocol",
      "server",
      "tools",
      "connector",
      "add to personal",
    ],
  },
});
