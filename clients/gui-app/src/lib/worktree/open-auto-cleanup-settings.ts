import type { UseNavigateResult } from "@tanstack/react-router";
import { ensureSettingsTab } from "@/lib/commands/actions/open-system-tab";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  selectWorktreeCleanupView,
  useWorktreeCleanupViewStore,
} from "@/stores/settings/worktree-cleanup-view-store";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";

/**
 * "Take me to automatic cleanup for THIS host" — the deep link a surface uses
 * when it has just shown someone proven-safe worktrees and wants to offer the
 * policy that removes them unattended.
 *
 * Assembled from the same three seams `routeHostSurfaceNotification` uses, in
 * the same order and for the same reasons: the host scope and the sub-view are
 * applied BEFORE navigating, so the panel reads them on its first render rather
 * than flashing the wrong host or the cleanup history. The difference is the
 * third hint - a notification names a run, this names the card - and it is a
 * hint in exactly the same sense: a host that is offline or too old renders no
 * card at all, and the destination still has to be the worktrees panel.
 *
 * `hostId` is the CALLING surface's latched host. `null` leaves Settings
 * administering whatever host it already was, which is the honest answer when
 * the caller has no machine of its own to name.
 */
export function openWorktreeAutoCleanupSettings(
  navigate: UseNavigateResult<string>,
  hostId: string | null,
): void {
  carryViewedHostIntoSettingsScope(hostId);
  selectWorktreeCleanupView("settings", null);
  useWorktreeCleanupViewStore.getState().requestAutoCleanupFocus();
  navigateToTabIntent(
    navigate,
    ensureSettingsTab({ subSection: "worktrees", resetToGeneral: false }),
    undefined,
  );
}
