import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

// Both cards are replaced by a notice for a remote host too old to answer the
// shell config RPC, and by a no-source notice for this computer's host with no
// CLI bridge, so they fold into the page, which renders for every host.
export const SHELL = defineSettingsSection("shell", {
  page: {
    availableWhen: alwaysAvailable,
    // The page's names from before environments in a build without them
    // (`unreleased-features.ts`).
    label: UNRELEASED_FEATURES_ENABLED ? "Variables & shells" : "Shell",
    description: UNRELEASED_FEATURES_ENABLED
      ? "Plain values every computer and sandbox running Personal gets, and the shell agents run in."
      : "How Traycer launches terminals, the host, and provider harnesses.",
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
      ...(UNRELEASED_FEATURES_ENABLED ? (["variables"] as const) : []),
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
    label: UNRELEASED_FEATURES_ENABLED
      ? "Variables · After restart"
      : "Host environment · After restart",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
