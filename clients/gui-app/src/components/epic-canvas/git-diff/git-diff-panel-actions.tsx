import { useCallback, useMemo } from "react";
import { FolderTree, List, RotateCcw } from "lucide-react";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useGitRefreshWorktreeStatus } from "@/hooks/git/use-git-refresh-worktree-status";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";

// Safety cap so a hung host fetch can't wedge the spinning/disabled state.
const GIT_REFRESH_TIMEOUT_MS = 10_000;

export function GitDiffPanelActions(props: LeftPanelSlotProps) {
  const listLayout = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).listLayout,
  );
  const selectedWorktree = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).selectedWorktree,
  );
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: props.epicId,
    enabled: true,
  });
  const selectedRow = useMemo(() => {
    const rows = bindingsQuery.data?.rows ?? [];
    return (
      rows.find(
        (row) =>
          selectedWorktree !== null &&
          worktreeRowKey(row) === worktreeRowKey(selectedWorktree) &&
          isGitSelectable(row),
      ) ?? null
    );
  }, [bindingsQuery.data?.rows, selectedWorktree]);

  const handleToggleLayout = useCallback(() => {
    const nextLayout = listLayout === "sections" ? "tree" : "sections";
    useGitPanelStore.getState().setListLayout(props.epicId, nextLayout);
  }, [listLayout, props.epicId]);

  const { mutateAsync: refreshWorktreeStatus } = useGitRefreshWorktreeStatus();
  const handleRefresh = useCallback(async () => {
    if (selectedRow === null) return;
    await refreshWorktreeStatus({
      hostId: selectedRow.hostId,
      runningDir: selectedRow.runningDir,
      ignoreWhitespace,
    });
  }, [ignoreWhitespace, refreshWorktreeStatus, selectedRow]);

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
        disabled={selectedRow === null || refresh.refreshing}
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
