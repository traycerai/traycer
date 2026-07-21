import { useCallback } from "react";
import { FolderTree, List, RotateCcw } from "lucide-react";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useGitSubmoduleSnapshotRefresh } from "@/hooks/git/use-git-submodule-snapshot-refresh";

// Safety cap so a hung host fetch can't wedge the spinning/disabled state.
const GIT_REFRESH_TIMEOUT_MS = 10_000;

export function GitDiffPanelActions(props: LeftPanelSlotProps) {
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
  const handleRefresh = useGitSubmoduleSnapshotRefresh({
    hostId: selectedRepo?.hostId ?? null,
    rootRunningDir: selectedRepo?.rootRunningDir ?? null,
    ignoreWhitespace,
  });

  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: GIT_REFRESH_TIMEOUT_MS,
  });

  return (
    <div className="flex items-center gap-0.5">
      <TooltipWrapper
        label={layoutToggleLabel}
        side="bottom"
        sideOffset={4}
        align="end"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleToggleLayout}
          aria-label={layoutToggleLabel}
          data-testid="git-diff-panel-layout-toggle"
          className="text-muted-foreground hover:text-foreground"
        >
          {listLayout === "sections" ? (
            <FolderTree className="size-4" />
          ) : (
            <List className="size-4" />
          )}
        </Button>
      </TooltipWrapper>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={refresh.trigger}
        aria-label="Refresh"
        disabled={selectedRepo === null || refresh.refreshing}
        data-testid="git-diff-panel-refresh"
        className="text-muted-foreground hover:text-foreground"
      >
        <RotateCcw
          className={cn("size-4", refresh.refreshing && "animate-spin")}
        />
      </Button>
    </div>
  );
}
