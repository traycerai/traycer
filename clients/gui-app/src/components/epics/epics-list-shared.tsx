/**
 * The chrome the desktop task list and the phone task list both render: the
 * non-row states (loading / error / empty), the row's status glyph, and the
 * "Show more" pager.
 *
 * They live outside both list bodies because the two bodies differ only in how
 * a ROW looks and what a touch on it means. Everything around the rows is the
 * same surface, and a second copy of it would be a second place for the empty
 * copy, the retry affordance and the pager to drift.
 *
 * Components only - the shared row-label rule is a plain function and lives in
 * `history-item-title`, so this module stays hot-reloadable.
 */
import { useState, type ReactNode } from "react";
import { Layers } from "lucide-react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Skeleton } from "@/components/ui/skeleton";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * The row's status glyph: the epic's notification indicator when it has one,
 * its running state when an agent is working, and a plain layers icon
 * otherwise. Status rather than an action, which is why both list bodies keep
 * it however far they trim the rest of the row.
 */
export function HistoryRowLeadingIcon(props: {
  readonly item: HistoryItem;
}): ReactNode {
  const activityStatus = useEpicActivityStatus(
    props.item.taskType === "epic" ? props.item.epicId : null,
  );
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.item.epicId },
    null,
  );
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={activityStatus === "idle" ? false : activityStatus}
      subjectId={props.item.epicId}
      testIdPrefix="epics-list-row"
      className="text-muted-foreground group-hover/list-row:text-foreground"
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={
        <Layers className="size-4 shrink-0 text-muted-foreground group-hover/list-row:text-foreground" />
      }
      statusPresentation="message"
      agentSurface="gui"
    />
  );
}

export function EpicsListLoading(): ReactNode {
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="epics-list-loading"
      aria-busy="true"
      aria-label="Loading tasks"
    >
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}

export function EpicsListFilteringLoading(): ReactNode {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-filter-loading"
      aria-busy="true"
      aria-live="polite"
    >
      <AgentSpinningDots
        variant="dots"
        className="text-muted-foreground"
        testId={undefined}
      />
      <p className="font-medium text-foreground">Searching tasks</p>
    </div>
  );
}

/**
 * Shown when a host filter is active but the serving peer cannot apply it, so
 * the rows were withheld. Deliberately NOT an empty-history message: the
 * account's tasks exist, this client just declined to show a list it could not
 * honestly call filtered.
 */
export function EpicsListChatHostFilterUnsupported(): ReactNode {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-[min(4rem,12vh)] text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-chat-host-filter-unsupported"
    >
      <p className="font-medium text-foreground">
        Can&apos;t filter by host here
      </p>
      <p className="max-w-full">
        This host is running a version that doesn&apos;t support the host
        filter. Update it, or clear the host filter to see your tasks.
      </p>
    </div>
  );
}

export function EpicsListEmpty(): ReactNode {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-empty"
    >
      <p className="font-medium text-foreground">No tasks yet</p>
    </div>
  );
}

export function EpicsListFilteredEmpty(): ReactNode {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-filtered-empty"
    >
      <p className="font-medium text-foreground">
        No tasks match these filters.
      </p>
    </div>
  );
}

export interface EpicsListShowMoreProps {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
}

export function EpicsListShowMore(props: EpicsListShowMoreProps): ReactNode {
  if (!props.hasNextPage) return null;
  return (
    <div className="mt-3 flex justify-center">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={props.isFetchingNextPage}
        onClick={props.onLoadMore}
        data-testid="epics-list-show-more"
      >
        {props.isFetchingNextPage ? (
          <AgentSpinningDots
            variant="dots"
            className="text-muted-foreground"
            testId={undefined}
          />
        ) : null}
        Show more
      </Button>
    </div>
  );
}

export interface EpicsListErrorProps {
  readonly error: Error;
  readonly onRetry: () => void;
}

export function EpicsListError(props: EpicsListErrorProps): ReactNode {
  const { error, onRetry } = props;
  const [showDetails, setShowDetails] = useState<boolean>(false);
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-ui-sm"
      data-testid="epics-list-error"
      role="alert"
    >
      <p className="font-medium text-destructive">{errorHeadline(error)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="epics-list-error-retry"
          onClick={onRetry}
        >
          Retry
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="epics-list-error-toggle-details"
          aria-expanded={showDetails}
          onClick={() => {
            setShowDetails((value) => !value);
          }}
        >
          {showDetails ? "Hide details" : "Show details"}
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Failed to load Epics",
            message: "The Epic list could not be loaded.",
            code: error instanceof HostRpcError ? error.code : null,
            source: "Epic list",
          })}
          presentation="text"
          className={undefined}
        />
      </div>
      {showDetails ? (
        <pre
          className="w-full overflow-x-auto rounded-md bg-background/70 p-2 font-mono text-code-xs text-muted-foreground"
          data-testid="epics-list-error-details"
        >
          {formatError(error)}
        </pre>
      ) : null}
    </div>
  );
}

function errorHeadline(error: Error): string {
  if (error instanceof HostRpcError) {
    if (error.code === "UNAUTHORIZED") return "Please sign in again.";
    if (error.code === "FORBIDDEN") {
      return "You don't have permission to view these epics.";
    }
  }
  return "Couldn't reach Traycer Cloud";
}

function formatError(error: Error): string {
  return `${error.name}: ${error.message}`;
}
