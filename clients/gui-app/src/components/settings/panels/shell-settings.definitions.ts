import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// Both cards are replaced by a notice for a remote host too old to answer the
// shell config RPC, and by a no-source notice for this computer's host with no
// CLI bridge, so they fold into the page, which renders for every host.
export const SHELL = defineSettingsSection("shell", {
  page: {
    label: "Shell",
    description:
      "How Traycer launches terminals, the host, and provider harnesses.",
    keywords: [
      "terminal",
      "bash",
      "zsh",
      "fish",
      "powershell",
      "console",
      "terminal shell",
      "new terminals",
      "shell program",
      "startup flags",
      "flags",
      "arguments",
      "wsl",
      "host environment",
      "env",
      "environment variables",
      "path",
      "proxy",
      "node options",
      "after restart",
    ],
  },
  terminalShell: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Terminal shell · New terminals",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
  hostEnvironment: {
    kind: "group",
    search: { contributesTo: "page" },
    label: "Host environment · After restart",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
