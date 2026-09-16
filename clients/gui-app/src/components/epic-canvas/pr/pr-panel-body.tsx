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
} from "lucide-react";
import type {
  PrLightItem,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import { WorkspaceHostSwitcher } from "@/components/home/host-workspace-selector/host-section";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { Button } from "@/components/ui/button";
import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";
import {
  useSurfaceHostPinWithDefault,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import { tabSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { PrRow, type PrRowEntry } from "@/components/epic-canvas/pr/pr-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";
import { revealSidebarNode } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

/**
 * The per-view PR pin defaults to the canvas host. Both header actions and
 * list consume one selected-host subscription, including on mobile. The header
 * stays mounted through empty, loading and failed reads so the user can always
 * choose another host. Merely opening an epic does not latch a pin.
 */
export function PrPanelBody(props: LeftPanelSlotProps): ReactNode {
  const canvasHostId = useCanvasHostId();
  const pin = useSurfaceHostPinWithDefault(
    tabSurfaceKey("pull-requests", props.tabId),
    canvasHostId,
  );
  const streamBinding = useSurfaceHostStreamBinding(pin.resolvedHostId);
  return (
    <StreamRuntimeContext.Provider value={streamBinding}>
      <PrPanelBodyLive {...props} pin={pin} />
    </StreamRuntimeContext.Provider>
  );
}

function PrPanelBodyLive(
  props: LeftPanelSlotProps & {
    readonly pin: SurfaceHostPin;
  },
): ReactNode {
  const hostId = props.pin.resolvedHostId;
  const mainCollapsed = useMainPanelCollapsed(props.tabId);
  const sectionCollapsed = useLeftPanelSectionCollapsed("pull-requests");
  const methodSupport = useStreamMethodSupport("pr.subscribeListForEpic");
  const methodSupported = methodSupport !== "unsupported";
  const isMobileViewport = useIsMobileViewport();

  const surfaceHidden = isMobileViewport
    ? false
    : mainCollapsed || sectionCollapsed;
  const enabled = !surfaceHidden && methodSupported;

  const subscription = usePrListSubscription({
    hostId,
    epicId: props.epicId,
    mode: "foreground",
    enabled,
  });

  // Never attribute the selected host's rows to the canvas host's presence.
  useRecordPrPresence(hostId, props.epicId, subscription.data?.items ?? null);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="pr-panel-surface"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <PrPanelHostPicker pin={props.pin} />
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

function PrPanelHostPicker(props: { readonly pin: SurfaceHostPin }): ReactNode {
  const options = useHostOptions();
  const { pin } = props;
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1"
      data-testid="pr-panel-host-picker"
    >
      <WorkspaceHostSwitcher
        hosts={options.hosts}
        activeHostId={pin.resolvedHostId}
        onSelect={pin.setSelection}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={options.isLoading}
        listsFailed={options.listsFailed}
        onRetryLists={options.retryLists}
        intent="pin"
        surface="inline"
      />
      {pin.isPinned ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => pin.setSelection(null)}
        >
          Use task host
        </Button>
      ) : null}
    </div>
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
  const { openTile } = useEpicTileNavigation();
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
          {props.group.items.map((item) => {
            const entry = props.buildEntry(item);
            return (
              <PrRow
                key={entry.key}
                entry={entry}
                hostId={props.hostId}
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
