import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ChevronRight,
  FolderGit2,
  GitPullRequest,
  Layers,
} from "lucide-react";
import type {
  PrLightItem,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { PrRow, type PrRowEntry } from "@/components/epic-canvas/pr/pr-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HoverCardGroup } from "@/components/ui/hover-card";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useRecordPrPresence } from "@/hooks/pr/use-pr-presence-probe";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  StreamRuntimeContext,
  useStreamMethodSupport,
} from "@/lib/host/stream-runtime-context";
import { makePrDetailTile, prDetailTileId } from "@/lib/pr/pr-detail-tile";
import {
  formatPrRowTitle,
  filterPrRepoGroups,
  formatPrStackCount,
  formatRepoGroupLabel,
  prStackRailEntries,
  fullyIdentifiedPrBase,
  groupPrItemsByRepo,
  prListRowKey,
  type PrRepoBlock,
  type PrRepoGroup,
} from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";
import { useMainPanelCollapsed } from "@/stores/epics/left-panel-store";
import { usePrPanelStore } from "@/stores/epics/pr-panel-store";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";
import { revealSidebarNode } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

/**
 * The panel follows the canvas host: every host serves the same cloud-backed
 * PR list, so which machine answers only decides whose checkouts fill in
 * owners, link groups, liveness and the local diff, and that is the canvas
 * host's job. Header actions and the list share one subscription on that
 * host, including on mobile.
 */
export function PrPanelBody(props: LeftPanelSlotProps): ReactNode {
  const canvasHostId = useCanvasHostId();
  const streamBinding = useSurfaceHostStreamBinding(canvasHostId);
  return (
    <StreamRuntimeContext.Provider value={streamBinding}>
      <PrPanelBodyLive {...props} hostId={canvasHostId} />
    </StreamRuntimeContext.Provider>
  );
}

function PrPanelBodyLive(
  props: LeftPanelSlotProps & {
    readonly hostId: string | null;
  },
): ReactNode {
  const hostId = props.hostId;
  const mainCollapsed = useMainPanelCollapsed(props.tabId);
  const methodSupport = useStreamMethodSupport("pr.subscribeListForEpic");
  const methodSupported = methodSupport !== "unsupported";
  const isMobileViewport = useIsMobileViewport();

  const surfaceHidden = isMobileViewport ? false : mainCollapsed;
  const enabled = !surfaceHidden && methodSupported;

  const subscription = usePrListSubscription({
    hostId,
    epicId: props.epicId,
    mode: "foreground",
    enabled,
  });

  // Presence is recorded under the host that served these rows, which is the
  // key the rail reads it back under.
  useRecordPrPresence(hostId, props.epicId, subscription.data?.items ?? null);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="pr-panel-surface"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 border-b border-border/60 px-2 py-1.5">
        <PrPanelActions
          key={hostId}
          subscription={subscription}
          enabled={enabled}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {!methodSupported ? (
          <PrHostUpdateRequired />
        ) : (
          <PrPanelBodyContent
            key={hostId}
            epicId={props.epicId}
            tabId={props.tabId}
            hostId={hostId}
            items={subscription.data?.items ?? []}
            sourceStatus={subscription.data?.sourceStatus ?? null}
            error={subscription.error}
            isPending={subscription.isPending}
            hasCachedData={subscription.data !== null}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The panel's list for rows already in hand. Exported for the sample
 * workspace's sidebar, which draws the same list from sample rows.
 */
export function PrPanelBodyContent(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
  readonly items: readonly PrLightItem[];
  readonly sourceStatus: PrSourceStatus | null;
  readonly error: { readonly message: string } | null;
  readonly isPending: boolean;
  readonly hasCachedData: boolean;
}): ReactNode {
  const { openTile } = useEpicTileNavigation();
  const stateFilter = usePrPanelStore((state) => state.stateFilter);
  const setStateFilter = usePrPanelStore((state) => state.setStateFilter);
  // Grouped on the complete list, then filtered: stack membership is decided
  // with every row present, so hiding a merged dependent cannot turn its
  // siblings into a stack they are not in (see `filterPrRepoGroups`).
  const allGroups = useMemo(
    () => groupPrItemsByRepo(props.items),
    [props.items],
  );
  const groups = useMemo(
    () =>
      stateFilter === "all"
        ? allGroups
        : filterPrRepoGroups(allGroups, (item) => item.state === stateFilter),
    [allGroups, stateFilter],
  );
  const visibleCount = useMemo(
    () => groups.reduce((count, group) => count + group.items.length, 0),
    [groups],
  );
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
                openTile(
                  tileIntent(
                    makePrDetailTile({
                      ...tileArgs,
                      name: formatPrRowTitle(item),
                    }),
                    { epicId },
                    "explicit",
                    "direct_ui",
                  ),
                );
              },
      };
    },
    [epicId, hostId, openTile],
  );
  const regionRef = useRef<HTMLDivElement>(null);
  const revealRequest = useSidebarNodeRevealRequest(props.tabId);
  const revealedRepo =
    revealRequest === null
      ? undefined
      : groups.find((group) =>
          group.items.some(
            (item) => buildEntry(item).tileId === revealRequest.nodeId,
          ),
        );
  const revealedRepoLabel =
    revealedRepo === undefined
      ? null
      : formatRepoGroupLabel(revealedRepo.repoIdentifier);
  useLayoutEffect(() => {
    if (revealRequest === null || revealedRepoLabel === null) return;
    if (
      regionRef.current === null ||
      !revealSidebarNode(
        regionRef.current,
        revealRequest.nodeId,
        revealRequest.nonce,
      )
    ) {
      return;
    }
    clearSidebarNodeRevealRequest(props.tabId, revealRequest.nonce);
  }, [props.tabId, revealRequest, revealedRepoLabel]);

  if (props.isPending && !props.hasCachedData) {
    return (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center px-3 py-6"
        data-testid="pr-panel-loading"
      >
        <AgentSpinningDots
          testId="pr-panel-loading-dots"
          variant="dots"
          className="size-5"
          tone="muted"
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
        action={null}
        testId="pr-panel-empty"
      />
    );
  }

  return (
    <div
      ref={regionRef}
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
      {/* Below the banners, so a stale or failed refresh still says so. */}
      {stateFilter !== "all" && visibleCount === 0 && props.items.length > 0 ? (
        <SidebarPanelEmptyState
          icon={GitPullRequest}
          title={`No ${stateFilter} pull requests`}
          description={null}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setStateFilter("all");
              }}
            >
              Show all
            </Button>
          }
          testId="pr-panel-filtered-empty"
        />
      ) : null}
      {/* One clock for every row's owners card, across repos. */}
      <HoverCardGroup>
        {groups.map((group) => (
          <PrRepoGroupSection
            key={formatRepoGroupLabel(group.repoIdentifier)}
            epicId={props.epicId}
            tabId={props.tabId}
            hostId={props.hostId}
            group={group}
            collapsed={
              collapsedRepos.has(formatRepoGroupLabel(group.repoIdentifier)) &&
              revealedRepoLabel !== formatRepoGroupLabel(group.repoIdentifier)
            }
            onToggle={toggleRepo}
            buildEntry={buildEntry}
          />
        ))}
      </HoverCardGroup>
    </div>
  );
}

/**
 * One repo's rows under a collapsible header. Rows are full-bleed and split by
 * hairlines (`divide-y`) rather than boxed, so the eye tracks one column of
 * titles down the panel instead of re-entering a card border per PR.
 */
function PrRepoGroupSection(props: {
  readonly hostId: string | null;
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
          {props.group.blocks.map((block) => {
            if (block.kind === "single") {
              const entry = props.buildEntry(block.item);
              return (
                <PrRow
                  key={entry.key}
                  entry={entry}
                  hostId={props.hostId}
                  epicId={props.epicId}
                  tabId={props.tabId}
                />
              );
            }
            return (
              <PrStackBlockView
                key={block.key}
                block={block}
                hostId={props.hostId}
                epicId={props.epicId}
                tabId={props.tabId}
                buildEntry={props.buildEntry}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

type PrStackBlock = Extract<PrRepoBlock, { readonly kind: "stack" }>;

/**
 * A stack drawn the way GitHub draws one: a header naming the stack, then
 * its layers top first down a vertical rail, and the base branch as the
 * rail's end. Every row sits on the rail with a node, so the eye reads
 * "these land on each other" without a label; a layer this epic did not
 * open is a dashed stretch of rail with a count, where it belongs in the
 * order, and the base is a hollow node, since it is a branch and not a PR.
 */
function PrStackBlockView(props: {
  readonly block: PrStackBlock;
  readonly hostId: string | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly buildEntry: (item: PrLightItem) => PrRowEntry;
}): ReactNode {
  const entries = prStackRailEntries(props.block);
  return (
    <div className="flex min-w-0 flex-col" data-testid="pr-stack">
      <PrStackHeader block={props.block} />
      {entries.map((entry, index) =>
        entry.kind === "layer" ? (
          <PrStackRailRow
            key={props.buildEntry(entry.item).key}
            first={index === 0}
            node="solid"
          >
            <PrRow
              entry={props.buildEntry(entry.item)}
              hostId={props.hostId}
              epicId={props.epicId}
              tabId={props.tabId}
            />
          </PrStackRailRow>
        ) : (
          <PrStackRailRow
            key={`absent:${entry.topPosition}`}
            first={index === 0}
            node="dashed"
          >
            <p
              className="px-3 py-1.5 text-ui-xs text-muted-foreground"
              data-testid="pr-stack-absent"
            >
              {formatAbsentLayers(entry.count)}
            </p>
          </PrStackRailRow>
        ),
      )}
      <PrStackRailRow first={entries.length === 0} node="base">
        <p
          className="flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-ui-xs text-muted-foreground"
          data-testid="pr-stack-base"
        >
          <span className="truncate font-mono">
            {props.block.baseRefName ?? "unknown base"}
          </span>
        </p>
      </PrStackRailRow>
    </div>
  );
}

/**
 * One slot on the stack rail: a gutter carrying the rail and this entry's
 * node, and the entry beside it. The rail runs from the first entry's node
 * down through the base node, so the top entry has no rail above it and the
 * base none below. A dashed node and rail mark layers that are not here.
 */
function PrStackRailRow(props: {
  readonly first: boolean;
  readonly node: "solid" | "dashed" | "base";
  readonly children: ReactNode;
}): ReactNode {
  const dashed = props.node === "dashed";
  return (
    <div className="flex min-w-0" data-testid="pr-stack-rail-row">
      <div className="flex w-6 shrink-0 flex-col items-center pl-3" aria-hidden>
        <span
          className={cn(
            "w-0 flex-1 border-l-2",
            props.first ? "border-transparent" : "border-primary/50",
            dashed && "border-dashed",
          )}
        />
        <span
          className={cn(
            "size-2.5 shrink-0 rounded-full border-2",
            props.node === "solid" && "border-primary bg-primary",
            dashed && "border-dashed border-primary/50 bg-background",
            props.node === "base" && "border-primary/60 bg-background",
          )}
        />
        <span
          className={cn(
            "w-0 flex-1 border-l-2",
            props.node === "base" ? "border-transparent" : "border-primary/50",
            dashed && "border-dashed",
          )}
        />
      </div>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/**
 * The line above a stack's layers: which stack it is, the branch it lands
 * on, and how many of its layers this epic carries. Label register (small,
 * muted) so it reads as a heading for the rail below.
 */
function PrStackHeader(props: { readonly block: PrStackBlock }): ReactNode {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-3 py-1 text-ui-xs text-muted-foreground"
      data-testid="pr-stack-header"
    >
      <Layers className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {props.block.number === null ? "Stack" : `Stack #${props.block.number}`}
        {" → "}
        {props.block.baseRefName ?? "unknown"}
      </span>
      <span className="shrink-0 tabular-nums">
        {formatPrStackCount(props.block)}
      </span>
    </div>
  );
}

function formatAbsentLayers(count: number): string {
  return count === 1
    ? "1 layer not in this task"
    : `${count} layers not in this task`;
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
