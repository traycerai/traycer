import { useMemo, type ReactNode } from "react";
import { AlertCircle, FolderGit2, GitPullRequest } from "lucide-react";
import type {
  PrLightItem,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { PrCard } from "@/components/epic-canvas/pr/pr-card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { makePrDetailTile } from "@/lib/pr/pr-detail-tile";
import {
  formatPrRowTitle,
  formatRepoGroupLabel,
  fullyIdentifiedPrBase,
  groupPrItemsByRepo,
  prListRowKey,
} from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";
import {
  useLeftPanelSectionCollapsed,
  useMainPanelCollapsed,
} from "@/stores/epics/left-panel-store";

/**
 * Pull Requests panel body. Subscribes in foreground mode on the default-host
 * stream client with an explicit visibility gate:
 *   enabled = sidebar expanded ∧ section expanded ∧ method supported
 *
 * Whole-sidebar collapse is CSS-only (`hidden` on the column) and would leave
 * the body mounted without this gate. Per-section collapse already unmounts
 * the body; the section check is still included so the gate is complete and
 * testable if mount semantics change.
 *
 * Layout mirrors the Settings > Worktrees repo listing: a flat repo header
 * (icon + owner/repo + count) over always-expanded PR cards - no accordion,
 * since an epic rarely has more than a handful of PRs. Clicking a card opens
 * the full-view tile.
 *
 * Host switcher: omitted (list follows the app active host). See PrPanelActions.
 */
export function PrPanelBody(props: LeftPanelSlotProps): ReactNode {
  const hostId = useReactiveActiveHostId();
  const mainCollapsed = useMainPanelCollapsed(props.tabId);
  const sectionCollapsed = useLeftPanelSectionCollapsed("pull-requests");
  const methodSupport = useStreamMethodSupport("pr.subscribeListForEpic");
  const methodSupported = methodSupport !== "unsupported";

  const enabled = !mainCollapsed && !sectionCollapsed && methodSupported;

  const subscription = usePrListSubscription({
    hostId,
    epicId: props.epicId,
    mode: "foreground",
    enabled,
  });

  if (!methodSupported) {
    return <PrHostUpdateRequired />;
  }

  return (
    <PrPanelBodyContent
      epicId={props.epicId}
      hostId={hostId}
      items={subscription.data?.items ?? []}
      sourceStatus={subscription.data?.sourceStatus ?? null}
      error={subscription.error}
      isPending={subscription.isPending}
      hasCachedData={subscription.data !== null}
    />
  );
}

function PrPanelBodyContent(props: {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly items: readonly PrLightItem[];
  readonly sourceStatus: PrSourceStatus | null;
  readonly error: { readonly message: string } | null;
  readonly isPending: boolean;
  readonly hasCachedData: boolean;
}): ReactNode {
  const tileNavigation = useEpicTileNavigation();
  const groups = useMemo(() => groupPrItemsByRepo(props.items), [props.items]);

  if (props.isPending && !props.hasCachedData) {
    return (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center px-3 py-6"
        data-testid="pr-panel-loading"
      >
        <AgentSpinningDots
          testId="pr-panel-loading-dots"
          variant="dots"
          className="size-5 text-muted-foreground"
        />
      </div>
    );
  }

  const bannerState = resolvePrPanelBannerState(
    props.items,
    props.sourceStatus,
    props.error,
  );

  if (bannerState.showEmpty) {
    return (
      <SidebarPanelEmptyState
        icon={GitPullRequest}
        title="No pull requests found for this epic's chats yet"
        description="PRs are discovered from the branches chats worked on."
        testId="pr-panel-empty"
      />
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto px-2 py-1.5"
      data-testid="pr-panel-body"
      data-source-status={props.sourceStatus ?? "none"}
    >
      {bannerState.ghUnavailable ? (
        <PrStatusBanner
          tone="warning"
          title="GitHub CLI unavailable"
          message="Install and sign in to the GitHub CLI (`gh auth login`) to refresh. Cached rows stay visible and may be stale."
          testId="pr-panel-gh-unavailable"
        />
      ) : null}
      {bannerState.showErrorNotice && !bannerState.ghUnavailable ? (
        <PrStatusBanner
          tone="error"
          title="Could not refresh pull requests"
          message={
            props.error?.message ??
            "Showing last-known data. Recovery is automatic."
          }
          testId="pr-panel-error-notice"
        />
      ) : null}
      {groups.map((group) => (
        <div
          key={formatRepoGroupLabel(group.repoIdentifier)}
          className="flex min-w-0 flex-col gap-1.5"
          data-testid="pr-repo-group"
        >
          <div
            className="flex min-w-0 items-center gap-1.5 px-1 pt-0.5 text-ui-xs text-muted-foreground"
            data-testid="pr-repo-group-header"
          >
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {formatRepoGroupLabel(group.repoIdentifier)}
            </span>
            <span className="shrink-0">{group.items.length}</span>
          </div>
          {group.items.map((item) => {
            const rowKey =
              props.hostId === null
                ? formatPrFallbackKey(item)
                : prListRowKey(item, props.hostId);
            const identified = fullyIdentifiedPrBase(item);
            const hostId = props.hostId;
            const onOpen =
              hostId === null || identified === null
                ? null
                : () => {
                    tileNavigation.openTileInEpic(
                      props.epicId,
                      makePrDetailTile({
                        hostId,
                        githubHost: identified.githubHost,
                        owner: identified.base.owner,
                        repo: identified.base.repo,
                        prNumber: identified.base.prNumber,
                        name: formatPrRowTitle(item),
                      }),
                    );
                  };
            return <PrCard key={rowKey} item={item} onOpen={onOpen} />;
          })}
        </div>
      ))}
    </div>
  );
}

function formatPrFallbackKey(item: PrLightItem): string {
  return prListRowKey(item, "no-host");
}

function resolvePrPanelBannerState(
  items: readonly PrLightItem[],
  sourceStatus: PrSourceStatus | null,
  error: { readonly message: string } | null,
): {
  readonly showEmpty: boolean;
  readonly ghUnavailable: boolean;
  readonly showErrorNotice: boolean;
} {
  const showEmpty =
    items.length === 0 &&
    (sourceStatus === "ok" ||
      sourceStatus === "cached" ||
      sourceStatus === null) &&
    error === null;
  const ghUnavailable = sourceStatus === "gh-unavailable";
  const showErrorNotice =
    error !== null || sourceStatus === "error" || sourceStatus === "partial";
  return { showEmpty, ghUnavailable, showErrorNotice };
}

function PrHostUpdateRequired(): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
      data-testid="pr-panel-host-update-required"
      role="status"
    >
      <AlertCircle className="size-8 text-muted-foreground/45" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/70">
          Update required to view pull requests
        </p>
        <p className="text-ui-xs text-muted-foreground/50">
          This host does not advertise the PR list stream yet. Update Traycer
          Host to enable the Pull Requests panel.
        </p>
      </div>
    </div>
  );
}

function PrStatusBanner(props: {
  readonly tone: "warning" | "error";
  readonly title: string;
  readonly message: string;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className={cn(
        "rounded-md border px-2.5 py-2 text-ui-xs",
        props.tone === "warning" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100",
        props.tone === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <p className="font-medium">{props.title}</p>
      <p className="mt-0.5 opacity-90">{props.message}</p>
    </div>
  );
}
