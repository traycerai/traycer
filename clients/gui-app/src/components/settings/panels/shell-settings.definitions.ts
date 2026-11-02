import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// Both cards are replaced by a notice for a remote host too old to answer the
// shell config RPC, and by a no-source notice for this computer's host with no
// CLI bridge, so they fold into the page, which renders for every host.
export const SHELL = defineSettingsSection("shell", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Variables & shells",
    description:
      "Plain values every computer and sandbox running Personal gets, and the shell agents run in.",
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
      "variables",
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
    label: "Variables · After restart",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
