import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ChevronRight,
  FolderGit2,
  GitPullRequest,
} from "lucide-react";
import type {
  PrLightItem,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { PrRow, type PrRowEntry } from "@/components/epic-canvas/pr/pr-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { usePrPresenceStore } from "@/stores/epics/pr-presence-store";
import { makePrDetailTile, prDetailTileId } from "@/lib/pr/pr-detail-tile";
import {
  formatPrRowTitle,
  formatRepoGroupLabel,
  fullyIdentifiedPrBase,
  groupPrItemsByRepo,
  prListRowKey,
  type PrRepoGroup,
} from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";
import {
  useLeftPanelSectionCollapsed,
  useMainPanelCollapsed,
} from "@/stores/epics/left-panel-store";

/**
 * Pull Requests panel body. Subscribes in foreground mode on the canvas host
 * stream client with an explicit visibility gate:
 *   enabled = sidebar expanded ∧ section expanded ∧ method supported
 *
 * Whole-sidebar collapse is CSS-only (`hidden` on the column) and would leave
 * the body mounted without this gate. Per-section collapse already unmounts
 * the body; the section check is still included so the gate is complete and
 * testable if mount semantics change.
 *
 * Layout mirrors the Settings > Worktrees repo listing: a collapsible repo
 * header (chevron + icon + owner/repo + count) over full-bleed rows separated
 * by hairlines - no cards, no per-row accordion. Clicking a row opens the
 * full-view tile. An owned-submodule PR gets its own repo header and its own
 * full row, placed directly under the superproject it shipped with (see
 * `orderRepoGroupKeys`).
 *
 * Host switcher: omitted (list follows the canvas-serving host). See PrPanelActions.
 */
export function PrPanelBody(props: LeftPanelSlotProps): ReactNode {
  const hostId = useCanvasHostId();
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

  // The rail's presence gate is fed from HERE - the open panel's own stream -
  // and nowhere else. Opening an epic performs no PR work at all, so this is
  // the only writer, and it is why an epic's PR icon appears from the second
  // open onward rather than the first (see `pr-presence-store`).
  const recordPrPresence = usePrPresenceStore((s) => s.recordPrPresence);
  const items = subscription.data?.items ?? null;
  useEffect(() => {
    // `null` is "no frame yet", which is NOT the same as "no PRs": writing
    // `false` there would blank the icon on every panel open before the first
    // frame lands, exactly the flicker the persisted store exists to prevent.
    if (hostId === null || items === null) return;
    recordPrPresence(hostId, props.epicId, items.length > 0);
  }, [hostId, items, props.epicId, recordPrPresence]);

  if (!methodSupported) {
    return <PrHostUpdateRequired />;
  }

  return (
    <PrPanelBodyContent
      epicId={props.epicId}
      tabId={props.tabId}
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
  readonly tabId: string;
  readonly hostId: string | null;
  readonly items: readonly PrLightItem[];
  readonly sourceStatus: PrSourceStatus | null;
  readonly error: { readonly message: string } | null;
  readonly isPending: boolean;
  readonly hasCachedData: boolean;
}): ReactNode {
  const tileNavigation = useEpicTileNavigation();
  const groups = useMemo(() => groupPrItemsByRepo(props.items), [props.items]);
  const [collapsedRepos, setCollapsedRepos] = useState<ReadonlySet<string>>(
    new Set<string>(),
  );
  const toggleRepo = useCallback((repoLabel: string): void => {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (!next.delete(repoLabel)) next.add(repoLabel);
      return next;
    });
  }, []);

  const hostId = props.hostId;
  const epicId = props.epicId;
  const openTileInEpic = tileNavigation.openTileInEpic;
  const buildEntry = useCallback(
    (item: PrLightItem): PrRowEntry => {
      const identified = fullyIdentifiedPrBase(item);
      const tileArgs =
        hostId === null || identified === null
          ? null
          : {
              hostId,
              githubHost: identified.githubHost,
              owner: identified.base.owner,
              repo: identified.base.repo,
              prNumber: identified.base.prNumber,
            };
      return {
        key:
          hostId === null
            ? formatPrFallbackKey(item)
            : prListRowKey(item, hostId),
        item,
        // Same deterministic id `makePrDetailTile` mints, so the row can ask
        // the canvas whether ITS tile is the one on screen.
        tileId: tileArgs === null ? null : prDetailTileId(tileArgs),
        onOpen:
          tileArgs === null
            ? null
            : () => {
                openTileInEpic(
                  epicId,
                  makePrDetailTile({
                    ...tileArgs,
                    name: formatPrRowTitle(item),
                  }),
                );
              },
      };
    },
    [epicId, hostId, openTileInEpic],
  );

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
      // Groups are separated by WHITESPACE, not another hairline. With every
      // repo header and every row sharing one continuous ruled stack, a header
      // read as just another row and the eye could not find where one repo's
      // block ended - the gap is what makes a group a block.
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto py-2"
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
        <PrRepoGroupSection
          key={formatRepoGroupLabel(group.repoIdentifier)}
          epicId={props.epicId}
          tabId={props.tabId}
          group={group}
          collapsed={collapsedRepos.has(
            formatRepoGroupLabel(group.repoIdentifier),
          )}
          onToggle={toggleRepo}
          buildEntry={buildEntry}
        />
      ))}
    </div>
  );
}

/**
 * One repo's rows under a collapsible header. Rows are full-bleed and split by
 * hairlines (`divide-y`) rather than boxed, so the eye tracks one column of
 * titles down the panel instead of re-entering a card border per PR.
 */
function PrRepoGroupSection(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly group: PrRepoGroup;
  readonly collapsed: boolean;
  readonly onToggle: (repoLabel: string) => void;
  readonly buildEntry: (item: PrLightItem) => PrRowEntry;
}): ReactNode {
  const label = formatRepoGroupLabel(props.group.repoIdentifier);
  const { onToggle } = props;
  const handleToggle = useCallback((): void => {
    onToggle(label);
  }, [onToggle, label]);
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid="pr-repo-group">
      <button
        type="button"
        aria-expanded={!props.collapsed}
        aria-label={`${props.collapsed ? "Expand" : "Collapse"} ${label}`}
        onClick={handleToggle}
        // Reads as a section label rather than a row: uppercase + tracking put
        // it in a different register from the PR titles below it, so the two
        // are never scanned as the same kind of thing.
        className="flex w-full min-w-0 items-center gap-1.5 px-3 py-1 text-left text-ui-xs font-medium tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none"
        data-testid="pr-repo-group-header"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            !props.collapsed && "rotate-90",
          )}
          aria-hidden
        />
        <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate normal-case">{label}</span>
        <span className="shrink-0 tabular-nums">
          {props.group.items.length}
        </span>
      </button>
      {props.collapsed ? null : (
        <div className="flex min-w-0 flex-col divide-y divide-border/25 border-y border-border/25">
          {props.group.items.map((item) => {
            const entry = props.buildEntry(item);
            return (
              <PrRow
                key={entry.key}
                entry={entry}
                epicId={props.epicId}
                tabId={props.tabId}
              />
            );
          })}
        </div>
      )}
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
        "m-2 rounded-md border px-2.5 py-2 text-ui-xs",
        // Theme tokens, not a fixed Tailwind ramp - see `pr-detail-tone.ts`:
        // the nine theme presets each redefine `--warning`, and an amber ramp
        // opts this banner out of every one of them.
        props.tone === "warning" &&
          "border-warning/30 bg-warning/10 text-warning-foreground",
        props.tone === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <p className="font-medium">{props.title}</p>
      <p className="mt-0.5 opacity-90">{props.message}</p>
    </div>
  );
}
