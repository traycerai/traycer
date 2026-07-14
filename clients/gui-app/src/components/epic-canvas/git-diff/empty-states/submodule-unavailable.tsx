import { useCallback, type ReactNode } from "react";
import { TriangleAlert, RotateCcw } from "lucide-react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";

const GIT_SUBMODULE_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Shown when a submodule module group's details could not be read by the host
 * (`availability: unavailable` - broken worktree, permissions, or a git error).
 * A visible degrade, never a silent empty section, with a targeted refresh.
 */
export function SubmoduleUnavailable(props: {
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  const onRefresh = props.onRefresh;
  const handleRefresh = useCallback((): Promise<void> => {
    onRefresh();
    return Promise.resolve();
  }, [onRefresh]);
  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: props.isRefreshing,
    timeoutMs: GIT_SUBMODULE_REFRESH_TIMEOUT_MS,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      data-testid="git-submodule-unavailable"
    >
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <TriangleAlert className="size-8 text-warning/70" aria-hidden />
        <div className="space-y-1">
          <p className="text-ui-sm text-muted-foreground/70">
            Submodule details unavailable
          </p>
          <p className="text-ui-xs text-muted-foreground/50">
            The host could not inspect this submodule.
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh.trigger}
          disabled={refresh.refreshing}
          data-testid="git-submodule-unavailable-refresh"
        >
          <RotateCcw
            className={cn(
              "mr-1.5 size-3.5",
              refresh.refreshing && "animate-spin",
            )}
            aria-hidden
          />
          Refresh
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Submodule details unavailable",
            message: "The host could not inspect the Git submodule.",
            code: null,
            source: "Git changes",
          })}
          presentation="text"
          className={undefined}
        />
      </div>
    </div>
  );
}
