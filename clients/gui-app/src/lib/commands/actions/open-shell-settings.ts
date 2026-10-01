import type { UseNavigateResult } from "@tanstack/react-router";
import { resolveSettingsTabIntent } from "@/lib/commands/actions/open-system-tab";
import {
  activateTabIntent,
  type TabNavigationOptions,
} from "@/lib/tab-navigation";

/**
 * The desktop's "Settings…" (native menu, tray, jump list) for an admitted
 * shell: Settings ▸ General, reset to its top.
 *
 * One function because two places open it: the command itself, and the
 * signed-out quit surface handing off once a sign-in lands. They must land in
 * the same place, so neither spells the intent out. Only the history shape
 * differs, and that is the caller's to say: the hand-off replaces the entry
 * it leaves, so Back from Settings does not return to a page that forwards
 * straight back.
 */
export function openShellSettings(
  navigate: UseNavigateResult<string>,
  options: TabNavigationOptions | undefined,
): void {
  activateTabIntent(
    navigate,
    resolveSettingsTabIntent({ subSection: "general", resetToGeneral: true }),
    options,
  );
}
