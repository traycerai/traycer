/**
 * Help-oriented commands. Uses a ReactCommandSource so it can close
 * over `runnerHost` for commands that open external links.
 */
import type { CommandItem, ReactCommandSource } from "@/lib/commands/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

export const helpSource: ReactCommandSource = {
  id: "help",
  useItems: (): ReadonlyArray<CommandItem> => {
    const openReportIssue = useDesktopDialogStore((s) => s.openReportIssue);
    return [
      {
        id: "help:keybindings",
        label: "Open keybindings reference",
        description:
          "Jump to the keybindings settings panel to see and edit every shortcut.",
        keywords: ["help", "keybindings", "shortcuts", "hotkeys"],
        group: "help",
        scope: "help",
        shortcut: null,
        actionId: null,
        run: (ctx) => ctx.router.navigateSettingsSection("keybindings"),
        subpage: null,
      },
      {
        id: "help:report-issue",
        label: "Report issue",
        description:
          "Open a pre-filled GitHub issue with your system information.",
        keywords: ["help", "bug", "report", "feedback", "issue", "github"],
        group: "help",
        scope: "help",
        shortcut: null,
        actionId: null,
        run: () => {
          openReportIssue();
        },
        subpage: null,
      },
    ];
  },
};
