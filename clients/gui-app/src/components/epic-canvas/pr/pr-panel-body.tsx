import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, GitPullRequest } from "lucide-react";
import type {
  PrLightItem,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";
import type { LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { PrListRow } from "@/components/epic-canvas/pr/pr-list-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { makePrDetailTile } from "@/lib/pr/pr-detail-tile";
import {
  expandedPrRowKey,
  formatPrRowTitle,
  formatRepoGroupLabel,
  fullyIdentifiedPrBase,
  groupPrItemsByRepo,
  pickAutoExpandItem,
  prListRowKey,
} from "@/lib/pr/pr-list-projection";
import { cn } from "@/lib/utils";
import {
  useLeftPanelSectionCollapsed,
  useMainPanelCollapsed,
} from "@/stores/epics/left-panel-store";
import {
  selectHasPrPanelEpicState,
  selectPrPanelEpicState,
  usePrPanelStore,
  type PrPanelExpandedRow,
} from "@/stores/epics/pr-panel-store";

/** An unknown-base row's transient (never-persisted) expansion for this
 * mount: `"auto"` defers to the recomputed first-open pick; `"explicit"`
 * records a user toggle (`key` is the expanded row, or `null` if none). */
type TransientExpansion =
  | { readonly kind: "auto" }
  | { readonly kind: "explicit"; readonly key: string | null };

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
  const hasEpicState = usePrPanelStore(selectHasPrPanelEpicState(props.epicId));
  const expandedPr = usePrPanelStore(
    (s) => selectPrPanelEpicState(props.epicId)(s).expandedPr,
  );
  const setExpandedPr = usePrPanelStore((s) => s.setExpandedPr);
  const tileNavigation = useEpicTileNavigation();

  // Unknown-base rows expand only in component state (never persisted):
  // `{ kind: "auto" }` defers to the recomputed first-open pick below; an
  // `"explicit"` key (or `null`) records a user toggle for this mount.
  const [transientExpansion, setTransientExpansion] =
    useState<TransientExpansion>({ kind: "auto" });

  // Captured once per mount: whether this epic had no persisted expansion
  // state when the panel opened. Unlike `hasEpicState`, this does not flip
  // once the effect below marks the epic visited, so the transient auto-pick
  // fallback (derived on every render, not snapshotted) stays visible after
  // that write instead of disappearing the instant it lands. A lazy `useState`
  // initializer (not a ref) captures it, since refs cannot be read at render
  // time and this value drives what's rendered.
  const [wasUnvisitedAtMount] = useState<boolean>(() => !hasEpicState);

  // First-ever open: auto-expand open-failing > open > most recent. Persists
  // an epic entry even when the pick is unknown-base (persists null) so a
  // later reopen does not re-auto-expand after the user collapses.
  useEffect(() => {
    if (hasEpicState) return;
    if (props.isPending) return;
    if (props.hostId === null) return;
    // Wait until we have a real frame (or an empty ok list) so we do not
    // mark the epic visited during the initial host-hydration gap.
    if (!props.hasCachedData && props.error === null) return;
    setExpandedPr(
      props.epicId,
      resolveAutoExpandPersistTarget(
        pickAutoExpandItem(props.items),
        props.hostId,
      ),
    );
  }, [
    hasEpicState,
    props.epicId,
    props.error,
    props.hasCachedData,
    props.hostId,
    props.isPending,
    props.items,
    setExpandedPr,
  ]);

  const persistedExpandedKey =
    expandedPr === null ? null : expandedPrRowKey(expandedPr);

  const groups = useMemo(() => groupPrItemsByRepo(props.items), [props.items]);

  const autoPickKey = useMemo(() => {
    if (transientExpansion.kind !== "auto") return null;
    if (!wasUnvisitedAtMount) return null;
    if (props.hostId === null) return null;
    return resolveTransientAutoPickKey(props.items, props.hostId);
  }, [props.hostId, props.items, transientExpansion, wasUnvisitedAtMount]);

  const handleToggle = useCallback(
    (item: PrLightItem): void => {
      if (props.hostId === null) return;
      const rowKey = prListRowKey(item, props.hostId);
      const identified = fullyIdentifiedPrBase(item);

      if (identified === null) {
        // Unknown-base: transient only. Clear any persisted expansion.
        const currentlyExpanded =
          transientExpansion.kind === "auto"
            ? autoPickKey === rowKey
            : transientExpansion.key === rowKey;
        setExpandedPr(props.epicId, null);
        setTransientExpansion({
          kind: "explicit",
          key: currentlyExpanded ? null : rowKey,
        });
        return;
      }

      const next: PrPanelExpandedRow = {
        hostId: props.hostId,
        githubHost: identified.githubHost,
        owner: identified.base.owner,
        repo: identified.base.repo,
        prNumber: identified.base.prNumber,
      };
      const nextKey = expandedPrRowKey(next);
      setTransientExpansion({ kind: "explicit", key: null });
      if (persistedExpandedKey === nextKey) {
        setExpandedPr(props.epicId, null);
        return;
      }
      setExpandedPr(props.epicId, next);
    },
    [
      autoPickKey,
      persistedExpandedKey,
      props.epicId,
      props.hostId,
      setExpandedPr,
      transientExpansion,
    ],
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
          className="flex min-w-0 flex-col gap-1"
          data-testid="pr-repo-group"
        >
          <p className="truncate px-1 text-ui-xs text-muted-foreground">
            {formatRepoGroupLabel(group.repoIdentifier)}
          </p>
          {group.items.map((item) => {
            const rowKey =
              props.hostId === null
                ? formatPrFallbackKey(item)
                : prListRowKey(item, props.hostId);
            const identified = fullyIdentifiedPrBase(item);
            const currentTransientKey =
              transientExpansion.kind === "auto"
                ? autoPickKey
                : transientExpansion.key;
            const expanded =
              identified === null
                ? currentTransientKey === rowKey
                : persistedExpandedKey === rowKey;
            const hostId = props.hostId;
            const onOpenFullView =
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
            return (
              <PrListRow
                key={rowKey}
                item={item}
                expanded={expanded}
                onToggle={() => {
                  handleToggle(item);
                }}
                onOpenFullView={onOpenFullView}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function formatPrFallbackKey(item: PrLightItem): string {
  return prListRowKey(item, "no-host");
}

/** First-open auto-expand persist target: `null` for no rows or an
 * unknown-base pick (its identity may still change), the row otherwise. */
function resolveAutoExpandPersistTarget(
  pick: PrLightItem | null,
  hostId: string,
): PrPanelExpandedRow | null {
  if (pick === null) return null;
  const identified = fullyIdentifiedPrBase(pick);
  if (identified === null) return null;
  return {
    hostId,
    githubHost: identified.githubHost,
    owner: identified.base.owner,
    repo: identified.base.repo,
    prNumber: identified.base.prNumber,
  };
}

/** First-open auto-expand pick, but only when it's unknown-base (a
 * fully-identified pick is handled by the persisted store instead). */
function resolveTransientAutoPickKey(
  items: readonly PrLightItem[],
  hostId: string,
): string | null {
  const pick = pickAutoExpandItem(items);
  if (pick === null) return null;
  if (fullyIdentifiedPrBase(pick) !== null) return null;
  return prListRowKey(pick, hostId);
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
