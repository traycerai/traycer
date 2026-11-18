import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { cn } from "@/lib/utils";

export interface NoChangesInWorktreeProps {
  readonly lastUpdatedAtMs: number | null;
}

const GIT_EMPTY_REFRESH_TIMEOUT_MS = 10_000;

function formatTimeSince(ms: number | null): string {
  if (ms === null) return "just now";

  const nowMs = Date.now();
  const diffMs = nowMs - ms;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  return `${diffHours}h ago`;
}

export function NoChangesInWorktree(props: NoChangesInWorktreeProps) {
  const queryClient = useQueryClient();

  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes("git"),
    });
  }, [queryClient]);
  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: GIT_EMPTY_REFRESH_TIMEOUT_MS,
  });

  const timeSince = formatTimeSince(props.lastUpdatedAtMs);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 text-center",
        "px-4 py-8",
      )}
    >
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <GitBranch className="size-8 text-muted-foreground/45" />
        <div className="space-y-1">
          <p className="text-ui-sm text-muted-foreground/60">No changes</p>
          <p className="text-ui-xs text-muted-foreground/50">
            Last updated {timeSince}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={refresh.trigger}
        disabled={refresh.refreshing}
        className="mt-2"
        data-testid="git-diff-empty-refresh"
      >
        <RotateCcw
          className={cn(
            "mr-1.5 size-3.5",
            refresh.refreshing && "animate-spin",
          )}
          data-testid="git-diff-empty-refresh-icon"
        />
        Refresh
      </Button>
    </div>
  );
}
