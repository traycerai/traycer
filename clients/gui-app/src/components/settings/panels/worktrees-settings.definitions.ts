import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

export const WORKTREES = defineSettingsSection("worktrees", {
  page: {
    label: "Worktrees",
    description: "Traycer-created worktrees on this host.",
    keywords: [
      "git",
      "branch",
      "checkout",
      "clone",
      "repo",
      "repository",
      "prune",
      "delete",
      "setup script",
      "teardown",
      "disk space",
    ],
  },
});
