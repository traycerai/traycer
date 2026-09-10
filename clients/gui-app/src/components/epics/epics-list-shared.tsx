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
 * Shared row decisions live here too. The responsive bodies have distinct row
 * layouts, but account-level truth (such as whether a cloud mutation can
 * target a row) must not drift between them.
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
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * A task row's status: the epic's notification indicator when it has one, its
 * running state when an agent is working, and `defaultIcon` otherwise. Every
 * surface that lists tasks reads the same two sources through this one
 * component, so a task that is running or wants attention looks the same in
 * the desktop list, the phone's history and the phone's nav drawer. Phases
 * have no live agent activity and are never looked up for it.
 *
 * `defaultIcon` is what an idle, unread-free row shows: a glyph where the
 * surface wants every row to carry one, or `null` where a row without status
 * should carry nothing at all.
 */
export function HistoryRowStatusIcon(props: {
  readonly item: HistoryItem;
  readonly testIdPrefix: string;
  readonly className: string | undefined;
  readonly defaultIcon: ReactNode;
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
      // An EPIC-level rollup, exactly as in the tab strip: a task's agents can
      // live on several machines, so no one host's coverage answers for the
      // row. Unserved-plane reporting belongs to the per-agent icons.
      activityCoverage="indeterminate"
      subjectId={props.item.epicId}
      testIdPrefix={props.testIdPrefix}
      className={props.className}
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={props.defaultIcon}
      statusPresentation="message"
      agentSurface="gui"
    />
  );
}

/**
 * The history row's leading glyph: the task's status, and a plain layers icon
 * when it has none. Status rather than an action, which is why both list
 * bodies keep it however far they trim the rest of the row.
 */
export function HistoryRowLeadingIcon(props: {
  readonly item: HistoryItem;
}): ReactNode {
  return (
    <HistoryRowStatusIcon
      item={props.item}
      testIdPrefix="epics-list-row"
      className="text-muted-foreground group-hover/list-row:text-foreground"
      defaultIcon={
        <Layers className="size-4 shrink-0 text-muted-foreground group-hover/list-row:text-foreground" />
      }
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

/**
 * Shown when NO listing was requested: this session holds no cloud verdict and
 * the negotiated host predates the local-first `epic.listTasks` leg, so the
 * only listing it can produce is one that spends the account's credential.
 *
 * The copy names the two remedies and nothing else, and every other phrasing
 * this state could take is a false statement, which is why the wording is
 * fenced here rather than left to a call site:
 *
 *  - a spinner claims something is in flight; nothing is, and nothing will be;
 *  - "No tasks yet" claims the account is empty, which is unknown;
 *  - anything about what the host holds versus what the cloud holds narrates
 *    a split the person never asked about - they know their tasks, not where
 *    each copy lives - and on this exact host it would also be wrong: the
 *    epics are there, the host simply cannot list them without a sign-in.
 *
 * It also does not say the cloud is unreachable. The cloud may be perfectly
 * fine; this client is declining to spend it on an unverified session.
 */
export function EpicsListHostRequiresCloudToList(): ReactNode {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-[min(4rem,12vh)] text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-host-requires-cloud-to-list"
    >
      <p className="font-medium text-foreground">
        Couldn&apos;t load your tasks
      </p>
      <p className="max-w-full">
        Your sign-in couldn&apos;t be confirmed, and this host version needs it
        to list tasks. Sign in again, or update the host, to see them.
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

/**
 * No rows AND no settled page. Not an empty account: the listing failed or was
 * withheld, so "No tasks yet" would be the one claim of completeness this page
 * cannot make. It says only that - the user is never told which side of the
 * listing failed - and offers the remedy that can actually change the answer.
 *
 * Under an unverified session that remedy is NOT a retry:
 * `useCloudEpicTasksQuery` settles the page as unavailable without dispatching
 * the cloud leg while the session holds no verdict, and its guarded `refetch`
 * resolves without a request under the same condition, so a Retry there is a
 * button that does nothing. Sign-in is what changes the verdict.
 */
export function EpicsListUnavailable(props: {
  readonly onRetry: () => void;
}): ReactNode {
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-unavailable"
      data-remedy={cloudAuthorized ? "retry" : "sign-in"}
      role="status"
    >
      <p className="font-medium text-foreground">
        Couldn&apos;t load your tasks
      </p>
      {cloudAuthorized ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="epics-list-unavailable-retry"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      ) : (
        <p>
          Your sign-in couldn&apos;t be confirmed. Sign in again to see them.
        </p>
      )}
    </div>
  );
}

/**
 * Every "there are no rows" reading, decided once for both responsive list
 * bodies. Ordering is load-bearing:
 *
 * 1. A pending cloud page is a renderable device snapshot, not a settled
 *    account result, so an empty one is still a load - never "No tasks yet".
 * 2. With no filters, an unavailable page is a failed load, not an empty
 *    account; a settled one is genuinely empty.
 * 3. Under a filter, a fetch in flight is the search spinner; an unavailable
 *    page is again a failed load (the filter was never evaluated over the
 *    account); only a settled page may say "No tasks match".
 *
 * Renders `null` for nothing: a caller reaches this only with zero rows.
 */
export function EpicsListNoRows(props: {
  readonly cloudPagePending: boolean;
  readonly cloudPageUnavailable: boolean;
  readonly hasActiveFilters: boolean;
  readonly isFetching: boolean;
  readonly onRetry: () => void;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
}): ReactNode {
  if (props.cloudPagePending) return <EpicsListLoading />;
  if (!props.hasActiveFilters) {
    return props.cloudPageUnavailable ? (
      <EpicsListUnavailable onRetry={props.onRetry} />
    ) : (
      <EpicsListEmpty />
    );
  }
  if (props.isFetching) return <EpicsListFilteringLoading />;
  if (props.cloudPageUnavailable) {
    return <EpicsListUnavailable onRetry={props.onRetry} />;
  }
  return (
    <>
      <EpicsListFilteredEmpty />
      <EpicsListShowMore
        hasNextPage={props.hasNextPage}
        isFetchingNextPage={props.isFetchingNextPage}
        onLoadMore={props.onLoadMore}
      />
    </>
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
  return "Couldn't load your tasks";
}

function formatError(error: Error): string {
  return `${error.name}: ${error.message}`;
}
