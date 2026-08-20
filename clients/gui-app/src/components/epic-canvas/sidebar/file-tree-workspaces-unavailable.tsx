import { useCallback, type ReactNode } from "react";
import { AlertCircle, Unplug } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import type { BindingsFailure } from "@/lib/worktree/bindings-failure";

const FILE_TREE_RETRY_TIMEOUT_MS = 10_000;

/**
 * Shown when the file-tree panel's worktree-bindings read FAILED, in place of
 * the "No workspace linked." empty state.
 *
 * That empty state is right for a host that answered and has nothing bound,
 * and wrong for one that could not be asked: it reads as a fact about the
 * agent ("you have not linked a workspace") when the truth is a fact about the
 * connection, and it offers no way back. This panel resolves no workspace
 * roots from a host that cannot answer, so a pinned host going offline landed
 * there - and host-scoped queries disable every automatic recovery route, so
 * nothing re-dialed on its own.
 *
 * It mirrors the git-diff panel's pair of failure states rather than sharing
 * them, because the copy and the test ids belong to this panel; what the two
 * DO share is {@link BindingsFailure}, so they can never disagree about which
 * failure a given error is.
 */
export function FileTreeWorkspacesUnavailable(props: {
  readonly failure: BindingsFailure;
  /** Display name of the host that did not answer. `null` while unresolved. */
  readonly hostName: string | null;
  /** Must resolve when the re-read SETTLES, or the spinner lies. */
  readonly onRetry: () => Promise<void>;
}): ReactNode {
  const onRetry = props.onRetry;
  const handleRefresh = useCallback((): Promise<void> => onRetry(), [onRetry]);
  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: FILE_TREE_RETRY_TIMEOUT_MS,
  });
  const unreachable = props.failure.kind === "unreachable";
  const Icon = unreachable ? Unplug : AlertCircle;
  const unreachableTitle =
    props.hostName === null
      ? "Can't reach this host"
      : `Can't reach ${props.hostName}`;
  const title = unreachable ? unreachableTitle : "Couldn't load workspaces";
  const reason =
    props.failure.kind === "answered"
      ? props.failure.message
      : "This panel is pointed at a host that isn't responding. Pick another host above, or try again.";

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground"
      data-testid="file-tree-workspaces-unavailable"
    >
      <Icon
        className={
          unreachable ? "size-8 text-warning/70" : "size-8 text-destructive/70"
        }
        aria-hidden
      />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/60">{title}</p>
        <p
          className="text-ui-xs text-muted-foreground/50"
          data-testid="file-tree-workspaces-unavailable-reason"
        >
          {reason}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={refresh.trigger}
        disabled={refresh.refreshing}
        data-testid="file-tree-workspaces-unavailable-retry"
      >
        {refresh.refreshing ? (
          <AgentSpinningDots
            className="mr-1.5"
            testId="file-tree-workspaces-unavailable-retry-spinner"
            variant={undefined}
          />
        ) : null}
        Retry
      </Button>
    </div>
  );
}
