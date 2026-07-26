import { useCallback, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type {
  PrActivityItem,
  PrChangedFile,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  usePrDetailSubscription,
  type PrDetailSubscriptionData,
} from "@/hooks/pr/use-pr-detail-subscription";
import { usePrQuoteTargets } from "@/hooks/pr/use-pr-quote-targets";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import {
  derivePrAttentionQueue,
  type PrAttentionItem,
} from "@/lib/pr/pr-attention-queue";
import {
  buildPrActivityQuote,
  buildPrCheckQuote,
  buildPrDescriptionQuote,
  buildPrFileQuote,
  buildPrOverviewQuote,
  sendPrQuoteToTarget,
} from "@/lib/pr/pr-quote";
import { cn } from "@/lib/utils";
import { PrDetailHeader } from "@/components/epic-canvas/pr/pr-detail-header";
import { PrDetailCard } from "@/components/epic-canvas/pr/pr-detail-card";
import { PrDetailCommits } from "@/components/epic-canvas/pr/pr-detail-commits";
import {
  PrDetailConversation,
  PrDetailDescriptionCard,
} from "@/components/epic-canvas/pr/pr-detail-conversation";
import { PrDetailQueue } from "@/components/epic-canvas/pr/pr-detail-queue";
import { PrDetailSummaryStrip } from "@/components/epic-canvas/pr/pr-detail-summary-strip";
import { PrDetailTabStrip } from "@/components/epic-canvas/pr/pr-detail-tab-strip";
import {
  PrDetailChecks,
  PrDetailFilesChanged,
} from "@/components/epic-canvas/pr/pr-detail-sections";
import {
  prDetailViewKey,
  usePrDetailTab,
  usePrDetailViewStore,
} from "@/stores/epics/pr-detail-view-store";

const PR_DETAIL_REFRESH_TIMEOUT_MS = 10_000;

/**
 * The reading column, matched to the chat transcript's own measure
 * (`max-w-3xl` + `px-6` in `chat-messages.tsx`). Every tab uses it - the
 * earlier full-bleed treatment for Files and Checks made those two tabs land
 * with a different left edge, different padding and a summary that jumped from
 * the gutter into the tab strip, so switching tabs re-laid-out the whole tile.
 * One column for all five means the header, the tabs and the content share a
 * single edge no matter which tab is open.
 */
const PR_DETAIL_COLUMN = "mx-auto w-full max-w-3xl px-6";

/**
 * Container width at which the column's right gutter is wide enough to hold
 * the context card WITHOUT the column giving up any width:
 * 768px column + 2 × (256px card + 24px inset + 24px clearance) = 1376px.
 *
 * Expressed as a container query, not a pane or tab count. "One tab open" is
 * only a proxy for "the gutter is wide enough", and the proxy leaks - the left
 * sidebar collapsing widens the tile without changing tab count, a two-pane
 * split can still leave one pane very wide, and a single tab on a small laptop
 * has no gutter at all. Measuring the container gets every one of those right.
 */
const CARD_AT_WIDE = "hidden @min-[1400px]:block";
const STRIP_BELOW_WIDE = "@min-[1400px]:hidden";

export function PrDetailBody(props: {
  readonly epicId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly isActive: boolean;
}): ReactNode {
  const subscription = usePrDetailSubscription({
    epicId: props.epicId,
    githubHost: props.githubHost,
    owner: props.owner,
    repo: props.repo,
    prNumber: props.prNumber,
    enabled: props.isActive,
  });

  const onRefresh = useCallback((): Promise<void> => {
    subscription.sendRefresh();
    return Promise.resolve();
  }, [subscription]);

  const refresh = useRefreshSpinner({
    onRefresh,
    externalRefreshing: false,
    timeoutMs: PR_DETAIL_REFRESH_TIMEOUT_MS,
  });

  if (!subscription.methodSupported) {
    return <PrDetailHostUpdateRequired />;
  }

  if (subscription.data === null) {
    if (subscription.error !== null) {
      return (
        <PrDetailFatalError
          message={subscription.error.message}
          onRefresh={refresh.trigger}
          refreshing={refresh.refreshing}
        />
      );
    }
    return (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center px-3 py-6"
        data-testid="pr-detail-loading"
      >
        <AgentSpinningDots
          testId="pr-detail-loading-dots"
          variant="dots"
          className="size-5 text-muted-foreground"
        />
      </div>
    );
  }

  const bannerState = resolvePrDetailBannerState(
    subscription.data.sourceStatus,
    subscription.error,
  );

  return (
    <div
      className="@container flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="pr-detail-body"
      data-source-status={subscription.data.sourceStatus}
    >
      {bannerState.ghUnavailable ? (
        <PrDetailStatusBanner
          tone="warning"
          message="GitHub CLI unavailable. Showing cached data, which may be stale."
          testId="pr-detail-gh-unavailable"
        />
      ) : null}
      {bannerState.showErrorNotice && !bannerState.ghUnavailable ? (
        <PrDetailStatusBanner
          tone="error"
          message={
            subscription.error?.message ??
            "Could not refresh this pull request. Showing last-known data."
          }
          testId="pr-detail-error-notice"
        />
      ) : null}
      <PrDetailLoaded
        data={subscription.data}
        githubHost={props.githubHost}
        refreshing={refresh.refreshing}
        onRefresh={refresh.trigger}
      />
    </div>
  );
}

/**
 * The loaded view: a document (header, tabs, content) inside a centred reading
 * column, with the context card overlaying the gutter that column already
 * leaves empty.
 *
 * The card OVERLAYS rather than reserves. A reserved band would pad the pane
 * and shift the column, so the card's presence and absence would produce two
 * different layouts; overlaying dead space means the column renders identically
 * either way and toggling the card costs no reflow. It also cannot cover a
 * "Fix in chat" button, because the column ends before the gutter starts.
 *
 * Inside that gutter the card is `sticky`, not pinned to the top: on a PR with
 * a long description the reader is several screens down by the time they want
 * to know what is blocking it, and a card that scrolled away would be visible
 * exactly when it is least needed.
 */
function PrDetailLoaded(props: {
  readonly data: PrDetailSubscriptionData;
  readonly githubHost: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  const { core, checks, activity, files, commits } = props.data;
  const viewKey = prDetailViewKey({
    githubHost: props.githubHost,
    owner: core.base.owner,
    repo: core.base.repo,
    prNumber: core.base.prNumber,
  });
  const tab = usePrDetailTab(viewKey);
  const setTab = usePrDetailViewStore((state) => state.setTab);
  const quote = usePrQuoteTargets({ viewKey, owners: core.owners });
  const openExternalLink = useRunnerOpenExternalLink();
  const queue = derivePrAttentionQueue({ core, checks, activity });
  const target = quote.target;

  const openDetails = useCallback(
    (url: string): void => {
      openExternalLink.mutate(url);
    },
    [openExternalLink],
  );

  const sendQueueItem = useCallback(
    (item: PrAttentionItem): void => {
      if (target === null) return;
      // A queue row is a one-line projection, so re-resolve the fact it came
      // from and quote the FULL body rather than the row's summary.
      if (item.kind === "check-failure") {
        const context = checks.contexts.find(
          (entry) => `check:${entry.name}` === item.key,
        );
        if (context !== undefined) {
          sendPrQuoteToTarget(target, buildPrCheckQuote(core, context));
          return;
        }
      }
      const source = activity.items.find(
        (entry) => `review:${entry.id}` === item.key,
      );
      sendPrQuoteToTarget(
        target,
        source === undefined
          ? buildPrOverviewQuote(core)
          : buildPrActivityQuote(core, source),
      );
    },
    [target, checks.contexts, activity.items, core],
  );

  const sendFile = useCallback(
    (file: PrChangedFile): void => {
      if (target === null) return;
      sendPrQuoteToTarget(target, buildPrFileQuote(core, file));
    },
    [target, core],
  );

  const sendActivity = useCallback(
    (item: PrActivityItem): void => {
      if (target === null) return;
      sendPrQuoteToTarget(target, buildPrActivityQuote(core, item));
    },
    [target, core],
  );

  const sendOverview = useCallback((): void => {
    if (target === null) return;
    sendPrQuoteToTarget(target, buildPrOverviewQuote(core));
  }, [target, core]);

  const sendDescription = useCallback((): void => {
    if (target === null) return;
    sendPrQuoteToTarget(target, buildPrDescriptionQuote(core));
  }, [target, core]);

  return (
    // `shrink-0`, NOT `flex-1 min-h-0`: this is the positioning context for the
    // gutter card, and it has to be as tall as the DOCUMENT for the card's
    // `sticky` to have anywhere to travel. Inside a scrolling flex column a
    // grown-or-shrunk child resolves to exactly one viewport, which would pin
    // the card to the first screen and let it scroll away after that.
    <div className="relative flex min-w-0 shrink-0 flex-col">
      <div className={cn("flex min-w-0 flex-col gap-5 pt-8", PR_DETAIL_COLUMN)}>
        <PrDetailHeader
          core={core}
          notLive={props.data.liveness === "cache-only"}
          observedAt={oldestObservedAt(props.data)}
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
        />
        <div className="flex min-w-0 flex-col gap-3">
          <PrDetailTabStrip
            tab={tab}
            onSelectTab={(next) => setTab(viewKey, next)}
            counts={{
              feedback: activity.items.length,
              files: files.totalCount ?? files.files.length,
              checks: checks.contexts.length,
              commits: commits.totalCount ?? commits.commits.length,
            }}
            blocking={{
              feedback: queue.items.filter(
                (item) => item.kind === "changes-requested",
              ).length,
              checks: queue.checkCounts.failing,
            }}
          />
          <div
            className={STRIP_BELOW_WIDE}
            data-testid="pr-detail-summary-slot"
          >
            <PrDetailSummaryStrip
              core={core}
              queue={queue}
              target={target}
              targets={quote.targets}
              onSelectTarget={quote.selectTarget}
            />
          </div>
        </div>
        <div className="min-w-0 pb-10">
          {tab === "overview" ? (
            <div className="flex min-w-0 flex-col gap-4">
              <PrDetailQueue
                queue={queue}
                target={target}
                onSendItem={sendQueueItem}
                onOpenDetails={openDetails}
              />
              <PrDetailDescriptionCard
                core={core}
                onQuote={target === null ? null : sendDescription}
              />
            </div>
          ) : null}
          {tab === "feedback" ? (
            <PrDetailConversation
              core={core}
              activity={activity}
              onQuoteItem={target === null ? null : sendActivity}
            />
          ) : null}
          {tab === "files" ? (
            <PrDetailFilesChanged
              files={files}
              prUrl={core.prUrl}
              additions={core.additions}
              deletions={core.deletions}
              onQuoteFile={target === null ? null : sendFile}
            />
          ) : null}
          {tab === "checks" ? (
            <PrDetailChecks
              core={core}
              checks={checks}
              counts={queue.checkCounts}
              onOpenDetails={openDetails}
            />
          ) : null}
          {tab === "commits" ? (
            <PrDetailCommits
              core={core}
              commits={commits}
              onOpenCommit={openDetails}
            />
          ) : null}
        </div>
      </div>
      <div
        className={cn("absolute inset-y-0 right-6 w-64", CARD_AT_WIDE)}
        data-testid="pr-detail-card-gutter"
      >
        <PrDetailCard
          core={core}
          checks={checks}
          activity={activity}
          queue={queue}
          target={target}
          targets={quote.targets}
          onSelectTarget={quote.selectTarget}
          onSendPr={sendOverview}
          className="sticky top-8"
        />
      </div>
    </div>
  );
}

function resolvePrDetailBannerState(
  sourceStatus: PrSourceStatus,
  error: { readonly message: string } | null,
): { readonly ghUnavailable: boolean; readonly showErrorNotice: boolean } {
  return {
    ghUnavailable: sourceStatus === "gh-unavailable",
    showErrorNotice:
      error !== null || sourceStatus === "error" || sourceStatus === "partial",
  };
}

/**
 * The single staleness hint shown in the header is the OLDEST of the five
 * per-section `observedAt` timestamps - the view as a whole is only as fresh
 * as its stalest section. Files and commits are independently timestamped
 * protocol sections, so a cached/mixed frame with differing section freshness
 * is reported honestly rather than trusting one heavy timestamp everywhere.
 */
function oldestObservedAt(data: PrDetailSubscriptionData): number | null {
  return [
    data.core.observedAt,
    data.checks.observedAt,
    data.activity.observedAt,
    data.files.observedAt,
    data.commits.observedAt,
  ].reduce<number | null>((oldest, candidate) => {
    if (candidate === null) return oldest;
    if (oldest === null) return candidate;
    return Math.min(oldest, candidate);
  }, null);
}

function PrDetailFatalError(props: {
  readonly message: string;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      data-testid="pr-detail-fatal-error"
      role="status"
    >
      <p className="max-w-md text-ui-sm text-muted-foreground">
        {props.message}
      </p>
      <button
        type="button"
        onClick={props.onRefresh}
        disabled={props.refreshing}
        className="text-ui-xs text-primary hover:underline disabled:opacity-60"
      >
        Try again
      </button>
    </div>
  );
}

function PrDetailHostUpdateRequired(): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
      data-testid="pr-detail-host-update-required"
      role="status"
    >
      <AlertCircle className="size-8 text-muted-foreground/45" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/70">
          Update required to view this pull request
        </p>
        <p className="text-ui-xs text-muted-foreground/50">
          This host does not advertise the PR detail stream yet. Update Traycer
          Host to enable the full view.
        </p>
      </div>
    </div>
  );
}

function PrDetailStatusBanner(props: {
  readonly tone: "warning" | "error";
  readonly message: string;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className={cn(
        "border-b px-4 py-2 text-ui-xs",
        props.tone === "warning" &&
          "border-warning/30 bg-warning/10 text-warning-foreground",
        props.tone === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {props.message}
    </div>
  );
}
