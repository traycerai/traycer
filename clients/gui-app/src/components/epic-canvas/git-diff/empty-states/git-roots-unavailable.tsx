import { useCallback, type ReactNode } from "react";
import { TriangleAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { cn } from "@/lib/utils";

const GIT_ROOTS_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Shown when EVERY Git workspace bound to the chat probes unavailable (all
 * worktrees deleted or broken while their bindings still list them). Distinct
 * from `NoGitWorktrees`: there the chat has no Git workspaces at all, so "add
 * workspaces" is the right nudge; here the user HAS workspaces that simply could
 * not be read, and that same nudge would be wrong. A visible degrade with a
 * retry that clears the probed-unavailable set and re-probes each root, never an
 * indefinite loading skeleton (which would read as "still loading" forever).
 */
export function GitRootsUnavailable(props: {
  readonly onRetry: () => void;
}): ReactNode {
  const onRetry = props.onRetry;
  const handleRefresh = useCallback((): Promise<void> => {
    onRetry();
    return Promise.resolve();
  }, [onRetry]);
  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: GIT_ROOTS_REFRESH_TIMEOUT_MS,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      data-testid="git-roots-unavailable"
    >
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <TriangleAlert className="size-8 text-warning/70" aria-hidden />
        <div className="space-y-1">
          <p className="text-ui-sm text-muted-foreground/70">
            Git workspaces unavailable
          </p>
          <p className="text-ui-xs text-muted-foreground/50">
            None of the workspaces in this chat could be read. They may have
            been moved or deleted.
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
        data-testid="git-roots-unavailable-retry"
      >
        <RotateCcw
          className={cn(
            "mr-1.5 size-3.5",
            refresh.refreshing && "animate-spin",
          )}
          aria-hidden
        />
        Retry
      </Button>
    </div>
  );
}
