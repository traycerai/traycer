import { useCallback, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { createReportIssueContext } from "@/lib/report-issue-context";

const GIT_BINDINGS_RETRY_TIMEOUT_MS = 10_000;

/**
 * Shown when the worktree-bindings read FAILED and the host ANSWERED - an
 * authorization refusal, an unsupported method, an internal error on the far
 * side. The machine is reachable; the operation is not.
 *
 * It is separate from {@link GitHostUnreachable} on purpose. That screen says
 * "can't reach <host>" and offers to re-dial or move off the pin, which are the
 * remedies for a machine that never answered and are the wrong ones here: the
 * host is right there, and the reason it gave is the only thing that can point
 * at a fix. Collapsing both into "can't reach" would repeat, one layer up, the
 * exact defect this panel's empty states were fixed for - naming a remedy the
 * user cannot act on and hiding the one fact that mattered.
 *
 * There is deliberately no "Use active host" here. Switching machines is not
 * indicated by an answered failure, and the host picker in the header is
 * reachable in this state anyway, so the affordance exists without this screen
 * asserting it is the fix.
 */
export function GitBindingsUnreadable(props: {
  /** The host's own message. The only thing here that can point at a cause. */
  readonly message: string;
  readonly onRetry: () => Promise<void>;
}): ReactNode {
  const onRetry = props.onRetry;
  const handleRefresh = useCallback((): Promise<void> => onRetry(), [onRetry]);
  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: GIT_BINDINGS_RETRY_TIMEOUT_MS,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      data-testid="git-bindings-unreadable"
    >
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <AlertCircle className="size-8 text-destructive/70" aria-hidden />
        <div className="space-y-1">
          <p className="text-ui-sm text-muted-foreground/70">
            Couldn&apos;t load workspaces
          </p>
          <p
            className="text-ui-xs text-muted-foreground/50"
            data-testid="git-bindings-unreadable-message"
          >
            {props.message}
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
          data-testid="git-bindings-unreadable-retry"
        >
          {refresh.refreshing ? (
            <AgentSpinningDots
              className="mr-1.5"
              testId="git-bindings-unreadable-retry-spinner"
              variant={undefined}
            />
          ) : null}
          Retry
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't load workspaces",
            message: props.message,
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
