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
import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { ListTasksCompleteness } from "@traycer/protocol/host/epic/unary-schemas";

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
 * A local-first response can be ready to render before its cloud counterpart.
 * An empty local snapshot is therefore not an empty account: the cloud page is
 * still authoritative for that answer.
 */
export function EpicsListCloudPagePending(): ReactNode {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-cloud-page-pending"
      aria-busy="true"
      aria-live="polite"
    >
      <AgentSpinningDots
        variant="dots"
        className="text-muted-foreground"
        testId={undefined}
      />
      <p className="font-medium text-foreground">Loading cloud tasks</p>
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
 * The copy names the HOST's missing capability, and every other phrasing this
 * state could take is a false statement, which is why the wording is fenced
 * here rather than left to a call site:
 *
 *  - a spinner claims something is in flight; nothing is, and nothing will be;
 *  - "No tasks yet" claims the account is empty, which is unknown;
 *  - "Showing what this device holds" claims the device is empty, and on this
 *    exact host it is not - the epics are there, the host simply has no way to
 *    list them without the cloud.
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
        This host needs cloud access to list Epics
      </p>
      <p className="max-w-full">
        It&apos;s running a version that can&apos;t list Epics from this device
        alone, and your sign-in couldn&apos;t be confirmed. Update the host, or
        sign in again, to see them.
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

/**
 * What this page is NOT, stated once above either responsive list body.
 *
 * A `pending` cloud page is deliberately an early return. Its `facets` are
 * necessarily partial, but a filter-count caveat is secondary to explaining
 * that the account-wide page has not arrived yet.
 */
export function HistoryCompletenessNotice(props: {
  readonly completeness: ListTasksCompleteness | null;
  readonly cloudPagePending: boolean;
}): ReactNode {
  const { completeness } = props;
  const cloudPagePending =
    props.cloudPagePending || completeness?.cloudPage === "pending";
  if (cloudPagePending) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="epics-list-completeness"
        data-cloud-page="pending"
        data-local-rows={completeness?.localRows}
        className="mb-3 flex flex-col gap-1 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground"
      >
        <p>Cloud tasks are still loading. Showing what this device holds.</p>
      </div>
    );
  }
  if (completeness === null) return null;
  const lines: string[] = [];
  if (completeness.cloudPage === "unavailable") {
    lines.push(
      "Cloud tasks couldn't be reached. Showing what this device holds.",
    );
  }
  if (completeness.localRows === "truncated") {
    // Deliberately says INCOMPLETE and not WHERE, because `truncated` has more
    // than one producer and they leave the gap in different places. The page
    // cap does drop a suffix; a filter meeting a row with no association
    // evidence, or a text query judged against a row whose root document could
    // not be read (so only the immutable creation title was available), drops a
    // row from the MIDDLE - an epic renamed after creation vanishes from a
    // search for the name it now has.
    //
    // The previous copy - "Showing the first tasks stored on this device, not
    // all" - was written when the cap was the only producer, and for the others
    // it is the wrong SHAPE of claim rather than merely imprecise: a reader
    // told they have a prefix concludes the rest is further down the list.
    //
    // Do NOT branch this line on which producer fired. The wire member
    // deliberately does not distinguish them, so a client that split the copy
    // would be reading a distinction it was never sent.
    lines.push(
      "Some tasks on this device couldn't be checked against your filters, so this list may be missing a few.",
    );
  }
  if (completeness.localRows === "suppressed-unprovable-filter") {
    // The difference between "you have no local epics matching" and "this
    // filter cannot be answered from this device". Collapsing them is how a
    // filtered offline History came to look empty and authoritative.
    lines.push(
      "This filter can't be checked against tasks stored on this device, so they aren't listed.",
    );
  }
  // `facets: "partial"` is the protocol saying the counts describe a DIFFERENT
  // set from the rows - host rows were injected beside them, or the cloud page
  // is missing. Both lines used to assert the opposite ("counts cover the tasks
  // listed here"), so the one state where the numbers provably disagree with
  // the list was reported as the state where they agree.
  if (completeness.sort === "loaded-union") {
    lines.push(
      completeness.facets === "partial"
        ? "Order covers the tasks listed here, and filter counts may leave some of them out."
        : "Order and counts cover the tasks listed here, not everything you have.",
    );
  } else if (completeness.facets === "partial") {
    lines.push("Filter counts may not include every task listed here.");
  }
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="epics-list-completeness"
      data-cloud-page={completeness.cloudPage}
      data-local-rows={completeness.localRows}
      className="mb-3 flex flex-col gap-1 rounded-md border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
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
