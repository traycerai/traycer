import { useCallback, useState, type ReactNode } from "react";
import { FolderTree, List, MoreHorizontal } from "lucide-react";
import type { LeftPanelHeaderSlotProps } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { RefreshIcon } from "@/components/refresh-icon";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useGitSubmoduleSnapshotRefresh } from "@/hooks/git/use-git-submodule-snapshot-refresh";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEpicLeftPanelStore } from "@/stores/epics/left-panel-store";
import {
  usePanelHeaderMenuOpen,
  usePanelHeaderMenuStore,
} from "@/stores/epics/panel-header-menu-store";

// Safety cap so a hung host fetch can't wedge the spinning/disabled state.
const GIT_REFRESH_TIMEOUT_MS = 10_000;

/**
 * The Git Diff panel's overflow-menu items and the mutations behind them. Every
 * container that hosts the menu mounts these - the sidebar header below, and the
 * phone body header, which has no panel header to hang a slot from. Placement is
 * the container's business; what the menu DOES is not.
 */
function GitDiffPanelMenuItems(props: { readonly epicId: string }): ReactNode {
  const listLayout = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).listLayout,
  );
  const selectedRepo = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).selectedRepo,
  );
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const layoutToggleLabel =
    listLayout === "sections" ? "Switch to tree view" : "Switch to list view";

  const handleToggleLayout = useCallback(() => {
    const nextLayout = listLayout === "sections" ? "tree" : "sections";
    useGitPanelStore.getState().setListLayout(props.epicId, nextLayout);
  }, [listLayout, props.epicId]);

  // Manual refresh is an explicit generation-aware unary fetch of the active
  // root's nested snapshot slot (the panel's source of truth for parent files
  // + submodules) - see `useGitSubmoduleSnapshotRefresh` for why it is not a
  // plain invalidate. The worktree-scoped request hits the correct host; on
  // an old host it still degrades to a parent-only snapshot.
  const { refresh: handleRefresh, isRefreshing } =
    useGitSubmoduleSnapshotRefresh({
      hostId: selectedRepo?.hostId ?? null,
      rootRunningDir: selectedRepo?.rootRunningDir ?? null,
      ignoreWhitespace,
    });

  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: isRefreshing,
    timeoutMs: GIT_REFRESH_TIMEOUT_MS,
  });

  return (
    <>
      <DropdownMenuItem
        onSelect={handleToggleLayout}
        data-testid="git-diff-panel-layout-toggle"
      >
        {listLayout === "sections" ? (
          <FolderTree className="size-4" />
        ) : (
          <List className="size-4" />
        )}
        {layoutToggleLabel}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={refresh.trigger}
        disabled={selectedRepo === null || refresh.refreshing}
        data-testid="git-diff-panel-refresh"
      >
        <RefreshIcon refreshing={refresh.refreshing} />
        Refresh
      </DropdownMenuItem>
    </>
  );
}

export function GitDiffPanelActions(props: LeftPanelHeaderSlotProps) {
  const menuOpen = usePanelHeaderMenuOpen(props.tabId, "git-diff", "more");
  const setMenuOpen = usePanelHeaderMenuStore((state) => state.setMenuOpen);
  const setPanelSectionCollapsed = useEpicLeftPanelStore(
    (state) => state.setPanelSectionCollapsed,
  );
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open && props.collapsed) {
        setPanelSectionCollapsed("git-diff", false);
      }
      setMenuOpen(props.tabId, "git-diff", "more", open);
    },
    [props.collapsed, props.tabId, setMenuOpen, setPanelSectionCollapsed],
  );

  return (
    <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <TooltipWrapper
        label="More Git Diff actions"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More Git Diff actions"
            data-testid="git-diff-panel-more"
            className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        avoidCollisions={false}
        className="w-[var(--radix-dropdown-menu-content-available-width)] min-w-0 max-w-52"
      >
        <GitDiffPanelMenuItems epicId={props.epicId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same overflow menu, for the phone tab switcher - which mounts the panel
 * BODY alone, with no left-panel header to carry the Actions slot. Without it
 * the list-layout toggle and the manual refresh have no reachable trigger on a
 * phone at all. The items and their mutations are the sidebar's; only the
 * trigger's home and the menu's placement differ, so the menu opens downward
 * from the body header instead of sideways out of a rail.
 *
 * Open state is local rather than the panel-header menu store: that store exists
 * to survive a collapsing sidebar section, and there is no such section here.
 */
export function GitDiffPanelInlineActions(props: {
  readonly epicId: string;
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="More Git Diff actions"
          data-testid="git-diff-panel-more"
          className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        // No `max-w-*` here: the primitive owns `max-w-safe-dvw`, and CSS
        // allows one width clamp per element, so a cap named by the caller
        // DISPLACES the safe-area one instead of tightening it.
        className="min-w-0"
      >
        <GitDiffPanelMenuItems epicId={props.epicId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
