import { useCallback } from "react";
import { FolderTree, List, MoreHorizontal } from "lucide-react";
import type { LeftPanelHeaderSlotProps } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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

export function GitDiffPanelActions(props: LeftPanelHeaderSlotProps) {
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
          {refresh.refreshing ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
