import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderTree, List, RotateCcw } from "lucide-react";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { invalidateGitSubmoduleSnapshot } from "@/lib/git/invalidate-git-submodule-snapshot";

// Safety cap so a hung host fetch can't wedge the spinning/disabled state.
const GIT_REFRESH_TIMEOUT_MS = 10_000;

export function GitDiffPanelActions(props: LeftPanelSlotProps) {
  const queryClient = useQueryClient();
  const listLayout = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).listLayout,
  );
  const selectedRepo = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).selectedRepo,
  );
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );

  const handleToggleLayout = useCallback(() => {
    const nextLayout = listLayout === "sections" ? "tree" : "sections";
    useGitPanelStore.getState().setListLayout(props.epicId, nextLayout);
  }, [listLayout, props.epicId]);

  // Manual refresh is a plain invalidate of the active root's nested
  // `git.listChangedFiles@1.1` slot (the panel's source of truth for parent files
  // + submodules). The worktree-scoped @1.1 query refetches on the correct host.
  // On an old host this refetch still degrades to a parent-only snapshot.
  const handleRefresh = useCallback(async () => {
    if (selectedRepo === null) return;
    await invalidateGitSubmoduleSnapshot(queryClient, {
      hostId: selectedRepo.hostId,
      rootRunningDir: selectedRepo.rootRunningDir,
      ignoreWhitespace,
    });
  }, [ignoreWhitespace, queryClient, selectedRepo]);

  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: GIT_REFRESH_TIMEOUT_MS,
  });

  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={handleToggleLayout}
        aria-label={
          listLayout === "sections"
            ? "Switch to tree layout"
            : "Switch to list layout"
        }
        data-testid="git-diff-panel-layout-toggle"
        className="text-muted-foreground hover:text-foreground"
      >
        {listLayout === "sections" ? (
          <FolderTree className="size-4" />
        ) : (
          <List className="size-4" />
        )}
      </Button>

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
