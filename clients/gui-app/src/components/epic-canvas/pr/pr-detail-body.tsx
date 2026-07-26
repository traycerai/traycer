import { useCallback, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type {
  PrActivitySection,
  PrChangedFile,
  PrCommitsSection,
  PrDetailCore,
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
import { PrDetailQueue } from "@/components/epic-canvas/pr/pr-detail-queue";
import { PrDetailSummaryStrip } from "@/components/epic-canvas/pr/pr-detail-summary-strip";
import { PrDetailTabStrip } from "@/components/epic-canvas/pr/pr-detail-tab-strip";
import {
  PrDetailFilesChanged,
  PrDetailMergeBox,
  PrDetailTimeline,
} from "@/components/epic-canvas/pr/pr-detail-sections";
import {
  isFullBleedPrDetailTab,
  prDetailViewKey,
  usePrDetailTab,
  usePrDetailViewStore,
} from "@/stores/epics/pr-detail-view-store";

const PR_DETAIL_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Container width at which the reading column's right gutter is finally wide
 * enough to hold the context card WITHOUT the column giving up any width:
 * `max-w-4xl` (896px) + 2 × (280px card + 24px margin) ≈ 1504px.
 *
 * Expressed as a container query, not a pane or tab count. "One tab open" is
 * only a proxy for "the gutter is wide enough", and the proxy leaks - the left
 * sidebar collapsing widens the tile without changing tab count, a two-pane
 * split can still leave one pane very wide, and a single tab on a small laptop
 * has no gutter at all. Measuring the container gets every one of those right.
 */
const CARD_AT_WIDE = "hidden @min-[1520px]:flex";
const STRIP_BELOW_WIDE = "@min-[1520px]:hidden";

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
  const isFullBleed = isFullBleedPrDetailTab(tab);
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

  const sendOverview = useCallback((): void => {
    if (target === null) return;
    sendPrQuoteToTarget(target, buildPrOverviewQuote(core));
  }, [target, core]);

  const sendDescription = useCallback((): void => {
    if (target === null) return;
    sendPrQuoteToTarget(target, buildPrDescriptionQuote(core));
  }, [target, core]);

  const summary = (variant: "capsule" | "strip"): ReactNode => (
    <PrDetailSummaryStrip
      core={core}
      queue={queue}
      target={target}
      targets={quote.targets}
      onSelectTarget={quote.selectTarget}
      variant={variant}
    />
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex min-w-0 flex-col",
          isFullBleed ? "w-full px-4" : "mx-auto w-full max-w-4xl px-6",
        )}
      >
        <PrDetailHeader
          core={core}
          notLive={props.data.liveness === "cache-only"}
          observedAt={oldestObservedAt(props.data)}
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
        />
        <PrDetailTabStrip
          tab={tab}
          onSelectTab={(next) => setTab(viewKey, next)}
          counts={{
            feedback: activity.items.length,
            files: files.totalCount ?? files.files.length,
            checks: checks.contexts.length,
            history: commits.totalCount ?? commits.commits.length,
          }}
          blocking={{
            feedback: queue.items.filter(
              (item) => item.kind === "changes-requested",
            ).length,
            checks: queue.checkCounts.failing,
          }}
          capsule={isFullBleed ? summary("capsule") : null}
        />
        {isFullBleed ? null : (
          <div className={cn("pb-4", STRIP_BELOW_WIDE)}>{summary("strip")}</div>
        )}
        <div className="min-w-0 pb-8">
          {tab === "overview" ? (
            <div className="flex min-w-0 flex-col gap-5">
              <PrDetailQueue
                queue={queue}
                target={target}
                onSendItem={sendQueueItem}
                onOpenDetails={openDetails}
              />
              <PrDetailDescription
                core={core}
                canSend={target !== null}
                onSend={sendDescription}
              />
            </div>
          ) : null}
          {tab === "feedback" ? (
            <PrDetailTimeline
              core={core}
              activity={activity}
              commits={commits}
              filter="activity"
              showDescription={false}
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
            <PrDetailMergeBox core={core} checks={checks} />
          ) : null}
          {tab === "history" ? (
            <PrDetailTimeline
              core={core}
              activity={activity}
              commits={commits}
              filter="commits"
              showDescription={false}
            />
          ) : null}
        </div>
      </div>
      {isFullBleed ? null : (
        <PrDetailCard
          core={core}
          checks={checks}
          activity={activity}
          queue={queue}
          target={target}
          targets={quote.targets}
          onSelectTarget={quote.selectTarget}
          onSendPr={sendOverview}
          className={cn("absolute top-4 right-6 w-[17.5rem]", CARD_AT_WIDE)}
        />
      )}
    </div>
  );
}

const EMPTY_ACTIVITY: PrActivitySection = {
  observedAt: null,
  items: [],
  isTruncated: false,
};

const EMPTY_COMMITS: PrCommitsSection = {
  observedAt: null,
  commits: [],
  totalCount: null,
  isTruncated: false,
};

function PrDetailDescription(props: {
  readonly core: PrDetailCore;
  readonly canSend: boolean;
  readonly onSend: () => void;
}): ReactNode {
  return (
    <section className="min-w-0" data-testid="pr-detail-description-section">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-ui-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Description
        </h2>
        <span className="h-px flex-1 bg-border/60" aria-hidden />
        <button
          type="button"
          onClick={props.onSend}
          disabled={!props.canSend}
          data-testid="pr-detail-description-quote"
          className="rounded border border-border/60 px-1.5 py-0.5 text-ui-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          Quote
        </button>
      </div>
      <PrDetailTimeline
        core={props.core}
        activity={EMPTY_ACTIVITY}
        commits={EMPTY_COMMITS}
        filter="activity"
        showDescription
      />
    </section>
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
