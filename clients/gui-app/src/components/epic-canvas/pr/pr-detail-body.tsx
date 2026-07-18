import { useCallback, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type { PrSourceStatus } from "@traycer/protocol/host/pr-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import {
  usePrDetailSubscription,
  type PrDetailSubscriptionData,
} from "@/hooks/pr/use-pr-detail-subscription";
import { cn } from "@/lib/utils";
import { PrDetailHeader } from "@/components/epic-canvas/pr/pr-detail-header";
import {
  PrDetailFilesChanged,
  PrDetailMergeBox,
  PrDetailTimeline,
} from "@/components/epic-canvas/pr/pr-detail-sections";
import { PrDetailSidebar } from "@/components/epic-canvas/pr/pr-detail-sidebar";

const PR_DETAIL_REFRESH_TIMEOUT_MS = 10_000;

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
      className="flex h-full min-h-0 flex-col overflow-y-auto"
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
      <div className="@container mx-auto flex w-full max-w-5xl flex-col px-6 py-6">
        <PrDetailHeader
          core={subscription.data.core}
          notLive={subscription.data.liveness === "cache-only"}
          observedAt={oldestObservedAt(subscription.data)}
          refreshing={refresh.refreshing}
          onRefresh={refresh.trigger}
        />
        <div className="mt-5 flex min-w-0 flex-col gap-6 @3xl:flex-row">
          <div className="min-w-0 flex-1">
            <PrDetailTimeline
              core={subscription.data.core}
              activity={subscription.data.activity}
              commits={subscription.data.commits}
            />
            <PrDetailFilesChanged
              files={subscription.data.files}
              prUrl={subscription.data.core.prUrl}
              additions={subscription.data.core.additions}
              deletions={subscription.data.core.deletions}
            />
            <PrDetailMergeBox
              core={subscription.data.core}
              checks={subscription.data.checks}
            />
          </div>
          <PrDetailSidebar
            core={subscription.data.core}
            activity={subscription.data.activity}
            className="@3xl:w-[clamp(12rem,28%,18rem)] @3xl:shrink-0"
          />
        </div>
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
          "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100",
        props.tone === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {props.message}
    </div>
  );
}
