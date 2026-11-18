/**
 * Help-oriented commands. Uses a ReactCommandSource so it can close
 * over `runnerHost` for commands that open external links.
 */
import type { CommandItem, ReactCommandSource } from "@/lib/commands/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const helpSource: ReactCommandSource = {
  id: "help",
  useItems: (): ReadonlyArray<CommandItem> => {
    const reportIssueAvailable = useDesktopDialogStore(
      (s) => s.reportIssueAvailable,
    );
    // The row navigates straight into a settings section, so it exists only
    // where that section does - otherwise it is the one entry point that
    // routes around the navigation, and its destination redirects elsewhere.
    const keybindingsAvailable = isSettingsSectionVisible("keybindings");
    const keybindings: CommandItem = {
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
    };
    const keybindingsItems = keybindingsAvailable ? [keybindings] : [];
    if (!reportIssueAvailable) return keybindingsItems;
    return [
      ...keybindingsItems,
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
          const state = useDesktopDialogStore.getState();
          if (!state.reportIssueAvailable) return;
          state.openReportIssue();
        },
        subpage: null,
      },
    ];
  },
};
