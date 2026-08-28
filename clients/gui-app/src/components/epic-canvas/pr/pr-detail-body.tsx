import { useCallback, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type {
  PrActivityItem,
  PrReviewThread,
  PrChangedFile,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { BoundedTileLoad } from "@/components/epic-canvas/renderers/tile-host-load-state";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
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
import { prCheckContextKey } from "@/lib/pr/pr-check-groups";
import {
  buildPrActivityQuote,
  buildPrReviewThreadQuote,
  buildPrCheckQuote,
  buildPrDescriptionQuote,
  buildPrFileQuote,
  buildPrOverviewQuote,
  sendPrQuoteToTarget,
  type PrQuoteTarget,
} from "@/lib/pr/pr-quote";
import { cn } from "@/lib/utils";
import {
  PrDetailHeader,
  PrDetailMergeLine,
} from "@/components/epic-canvas/pr/pr-detail-header";
import { PrDetailCard } from "@/components/epic-canvas/pr/pr-detail-card";
import { PrDetailCommits } from "@/components/epic-canvas/pr/pr-detail-commits";
import {
  PrDetailConversation,
  PrDetailDescriptionCard,
} from "@/components/epic-canvas/pr/pr-detail-conversation";
import { PrDetailQueue } from "@/components/epic-canvas/pr/pr-detail-queue";
import { PrDetailTabStrip } from "@/components/epic-canvas/pr/pr-detail-tab-strip";
import { PrDetailChecks } from "@/components/epic-canvas/pr/pr-detail-sections";
import { PrDetailFilesTab } from "@/components/epic-canvas/pr/pr-detail-files-tab";
import {
  prDetailTabButtonId,
  prDetailTabPanelId,
  prDetailViewKey,
  usePrDetailTab,
  usePrDetailViewStore,
} from "@/stores/epics/pr-detail-view-store";

const PR_DETAIL_REFRESH_TIMEOUT_MS = 10_000;

/**
 * The shell is a TWO-COLUMN ROW, not a centred column with the card parked
 * beside it.
 *
 * Three geometries were tried before this one, and each failed the same way -
 * by insisting the reading column stay centred in something:
 *
 * 1. Card overlaying a symmetric gutter. Needed BOTH gutters wide enough, so
 *    the threshold sat near real window widths and the card never appeared.
 * 2. Same, with the card shrunk to 224px to drag the threshold down. Appeared,
 *    but too narrow to read - branch names broke mid-word.
 * 3. Card in a reserved right band, column centred in what was left. The card
 *    was full width again, but centring in the remainder pushed the column
 *    RIGHT, opening a ~195px hole between the prose and the card.
 *
 * A flex row has none of those failure modes: the column takes the space that
 * is actually there, the gap is a gap and not a leftover, and the card is a
 * stretched flex item, so `sticky` works with no absolute positioning at all.
 * `max-w-3xl` when alone keeps the chat transcript's measure; the wider cap
 * applies only when the card is in the row beside it.
 *
 * Still a container query rather than a pane or tab count: "one tab open" is
 * only a proxy for "there is room", and the proxy leaks - collapsing the left
 * sidebar widens the tile without changing tab count, and a two-pane split can
 * still leave one pane very wide.
 */
// Both caps pair their rem ceiling with a viewport term, the `min(Xvw, Yrem)`
// form used throughout the app, so neither is a fixed layout dimension: the
// rem is only the upper bound once the viewport is wide enough to afford it.
const PR_DETAIL_SHELL_WIDTH = "max-w-3xl @min-[1180px]:max-w-[min(92vw,72rem)]";
const CARD_AT_WIDE = "hidden @min-[1180px]:block";
const CARD_WIDTH = "w-full max-w-[min(24vw,18rem)]";

export function PrDetailBody(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly isActive: boolean;
}): ReactNode {
  // The tile's bound host - the one `usePrDetailSubscription` subscribes
  // through, so the one whose silence the bounded load is about.
  const detailTabHostId = useTabHostId();
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
    // Invariant 6: this spinner had no end. The tile's reachability gate
    // catches a host the directory dropped; a host that stays listed while its
    // detail stream never delivers landed exactly here, forever.
    return (
      <BoundedTileLoad
        hostId={detailTabHostId}
        subject="pull-request"
        onRetry={refresh.trigger}
        testId="pr-detail-load"
        fallback={
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
        }
      />
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
        epicId={props.epicId}
        githubHost={props.githubHost}
        viewTabId={props.viewTabId}
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
  readonly epicId: string;
  readonly githubHost: string;
  readonly viewTabId: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  const { core, checks, activity, reviewThreads, files, commits } = props.data;
  const tileNavigation = useEpicTileNavigation();
  const hostId = useTabHostId();
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

  /**
   * "Fix in chat" reported as a dead button, and it was not disabled - it wrote
   * the quote into the target's composer draft and left the reader looking at
   * the PR. If that chat's tab is not the visible one, a correct send and a
   * no-op are indistinguishable.
   *
   * So the imperative affordance FINISHES the gesture: it reveals the chat it
   * just wrote to, composer focused, quote in place, one keystroke from sent.
   * The passive `⌁` glyphs (description, a comment, a file row) deliberately do
   * NOT - those are for stacking context before you go, and yanking the tab out
   * from under someone collecting three quotes would be its own bug.
   */
  const revealTarget = useCallback(
    (next: PrQuoteTarget): void => {
      tileNavigation.openTileInTab(
        props.viewTabId,
        makeOpenableNodeRef({
          id: next.id,
          instanceId: uuidv4(),
          type: next.kind === "chat" ? "chat" : "terminal-agent",
          name: next.title,
          hostId,
        }),
      );
    },
    [tileNavigation, props.viewTabId, hostId],
  );

  const sendQueueItem = useCallback(
    (item: PrAttentionItem): void => {
      if (target === null) return;
      // A queue row is a one-line projection, so re-resolve the fact it came
      // from and quote the FULL body rather than the row's summary.
      if (item.kind === "check-failure") {
        // Rebuild the queue's own key rather than guessing at `entry.name`:
        // `derivePrAttentionQueue` keys on `prCheckContextKey(context, index)`
        // over this same `checks.contexts`, so anything else never matches and
        // silently downgrades the quote to the generic overview.
        const context = checks.contexts.find(
          (entry, index) =>
            `check:${prCheckContextKey(entry, index)}` === item.key,
        );
        if (context !== undefined) {
          sendPrQuoteToTarget(target, buildPrCheckQuote(core, context));
          revealTarget(target);
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
      revealTarget(target);
    },
    [target, checks.contexts, activity.items, core, revealTarget],
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

  const sendReviewThread = useCallback(
    (thread: PrReviewThread): void => {
      if (target === null) return;
      sendPrQuoteToTarget(target, buildPrReviewThreadQuote(core, thread));
    },
    [target, core],
  );

  const sendDescription = useCallback((): void => {
    if (target === null) return;
    sendPrQuoteToTarget(target, buildPrDescriptionQuote(core));
  }, [target, core]);

  return (
    // `shrink-0`, NOT `flex-1 min-h-0`: this row has to be as tall as the
    // DOCUMENT for the card's `sticky` to have anywhere to travel. Inside a
    // scrolling flex column a grown-or-shrunk child resolves to exactly one
    // viewport, which would pin the card to the first screen and let it scroll
    // away after that. The card is a stretched flex ITEM, so it inherits that
    // full height without any absolute positioning.
    <div
      className={cn(
        "mx-auto flex w-full min-w-0 shrink-0 gap-8 px-6",
        PR_DETAIL_SHELL_WIDTH,
      )}
      data-testid="pr-detail-shell"
    >
      <div
        className="flex min-w-0 flex-1 flex-col gap-5"
        data-testid="pr-detail-column"
      >
        {/* Title + tabs travel together in ONE sticky bar, so the strip needs
            no hard-coded offset for the title's height - a wrapping title on a
            narrow tile would break any number chosen here. `bg-canvas` is
            load-bearing: a transparent sticky bar lets the diff scroll
            visibly through it. */}
        <div
          className="sticky top-0 z-20 -mx-1 flex min-w-0 flex-col gap-3 bg-canvas px-1 pt-8 pb-3"
          data-testid="pr-detail-sticky-bar"
        >
          <PrDetailHeader
            core={core}
            epicId={props.epicId}
            notLive={props.data.liveness === "cache-only"}
            observedAt={oldestObservedAt(props.data)}
            notice={props.data.notice}
            refreshing={props.refreshing}
            onRefresh={props.onRefresh}
          />
          <PrDetailMergeLine core={core} />
          <PrDetailTabStrip
            tab={tab}
            onSelectTab={(next) => setTab(viewKey, next)}
            counts={{
              // Inline findings ARE feedback, and on a bot-reviewed PR they are
              // most of it - counting only the top-level entries reported "1"
              // for a review carrying five objections.
              feedback: activity.items.length + reviewThreads.threads.length,
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
        </div>
        <div
          role="tabpanel"
          id={prDetailTabPanelId(tab)}
          aria-labelledby={prDetailTabButtonId(tab)}
          tabIndex={0}
          className="min-w-0 pb-10 focus-visible:outline-none"
        >
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
              reviewThreads={reviewThreads}
              onQuoteItem={target === null ? null : sendActivity}
              onQuoteThread={target === null ? null : sendReviewThread}
            />
          ) : null}
          {tab === "files" ? (
            <PrDetailFilesTab
              core={core}
              files={files}
              epicId={props.epicId}
              viewTabId={props.viewTabId}
              hostId={hostId}
              onQuoteFile={target === null ? null : sendFile}
            />
          ) : null}
          {tab === "checks" ? (
            <PrDetailChecks
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
      <aside
        className={cn("shrink-0 pt-8", CARD_WIDTH, CARD_AT_WIDE)}
        data-testid="pr-detail-card-gutter"
      >
        <PrDetailCard
          core={core}
          activity={activity}
          queue={queue}
          epicId={props.epicId}
          notLive={props.data.liveness === "cache-only"}
          className="sticky top-8"
        />
      </aside>
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
 * The single staleness hint shown in the header is the OLDEST of the six
 * per-section `observedAt` timestamps - the view as a whole is only as fresh
 * as its stalest section. Files, commits and review threads are independently
 * timestamped protocol sections, so a cached/mixed frame with differing
 * section freshness is reported honestly rather than trusting one heavy
 * timestamp everywhere.
 *
 * Every section carrying an `observedAt` belongs here. Omitting one lets the
 * header claim the view is fresher than its stalest visible content actually
 * is, which is the exact dishonesty this hint exists to prevent.
 */
function oldestObservedAt(data: PrDetailSubscriptionData): number | null {
  return [
    data.core.observedAt,
    data.checks.observedAt,
    data.activity.observedAt,
    data.files.observedAt,
    data.commits.observedAt,
    data.reviewThreads.observedAt,
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
