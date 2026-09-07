import { useCallback, type ReactNode } from "react";
import { Unplug } from "lucide-react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { createReportIssueContext } from "@/lib/report-issue-context";

const GIT_HOST_RETRY_TIMEOUT_MS = 10_000;

/**
 * That is the right nudge for a host that answered and has no git workspaces, and the wrong one for a host that never answered: it names a remedy on the wrong machine, and it is indistinguishable from the genuinely-empty case, so a user cannot tell "you have nothing here" from "we could not ask".
 * That second one is the load-bearing half: the pin's designed recovery is auto-follow on lease death, which needs `CONFIRMED_DEATH_REFUSAL_STREAK` transport-confirmed refusals to land before the pin is deposed - a condition this panel can neither observe nor force, and whose failure is exactly how this screen becomes permanent.
 */
export function GitHostUnreachable(props: {
  /** Display name of the host that did not answer. `null` while unresolved. */
  readonly hostName: string | null;
  /** Must resolve when the re-dial SETTLES. */
  readonly onRetry: () => Promise<void>;
  /**
   * `null` when the panel is not pinned (or is pinned to the effective host), where the action would move nothing and must not be offered.
   */
  readonly onUseActiveHost: (() => void) | null;
}): ReactNode {
  const onRetry = props.onRetry;
  const handleRefresh = useCallback((): Promise<void> => onRetry(), [onRetry]);
  const refresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: false,
    timeoutMs: GIT_HOST_RETRY_TIMEOUT_MS,
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      data-testid="git-host-unreachable"
    >
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <Unplug className="size-8 text-warning/70" aria-hidden />
        <div className="space-y-1">
          <p className="text-ui-sm text-muted-foreground/70">
            {props.hostName === null
              ? "Can't reach this host"
              : `Can't reach ${props.hostName}`}
          </p>
          <p className="text-ui-xs text-muted-foreground/50">
            This panel is pointed at a host that isn't responding, so its
            workspaces couldn't be loaded. Pick another host above, or try
            again.
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
          data-testid="git-host-unreachable-retry"
        >
          {refresh.refreshing ? (
            <AgentSpinningDots
              className="mr-1.5"
              testId="git-host-unreachable-retry-spinner"
              variant={undefined}
            />
          ) : null}
          Retry
        </Button>
        {props.onUseActiveHost === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onUseActiveHost}
            data-testid="git-host-unreachable-use-active"
          >
            Use active host
          </Button>
        )}
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Can't reach host",
            message:
              "The workspaces for this agent could not be loaded from the selected host.",
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
