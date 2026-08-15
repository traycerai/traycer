import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  useQueryClient,
  type Query,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  PrDetailCore,
  PrGetLocalDiffResponse,
  PrGetLocalDiffSummaryResponse,
} from "@traycer/protocol/host/pr-schemas";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { usePrDetailSubscription } from "@/hooks/pr/use-pr-detail-subscription";
import {
  isHostUnsupportedError,
  prLocalDiffTarget,
  usePrLocalDiffQuery,
  usePrLocalDiffSummaryQuery,
  type PrLocalDiffTarget,
} from "@/hooks/pr/use-pr-local-diff";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import { DiffTabShell } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import {
  DiffTabToolbar,
  type DiffTabToolbarView,
  type DiffTabToolbarViewPatch,
} from "@/components/epic-canvas/git-diff/diff-tab-toolbar";
import { DiffBundleLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-bundle-loading-skeleton";
import { PrLocalDiffBody } from "@/components/epic-canvas/pr/pr-local-diff-body";
import { PrDetailDeadTileBanner } from "./dead-tile-banner";

interface PrDiffTileProps {
  readonly node: PrDiffTileRef;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly isActive: boolean;
}

/**
 * The PR's diff as a full canvas tile - the same shell, toolbar and
 * collapsible per-file sections as the Git Diff bundle tile, over a
 * `base...head` range read from the local checkout instead of the working
 * tree.
 *
 * It exists as a TILE rather than as a section inside the PR view for the
 * reason every other full diff does: a diff wants the whole pane. Inline, it
 * competed with the PR's own header, tab strip and context card for width, and
 * could not be split beside the conversation it is about. As a tile it drags
 * to a split, persists its collapse state, and is reachable from the tab strip
 * like any other diff.
 *
 * Gates on the tile's BOUND host only, like `PrDetailTile` and unlike
 * `GitDiffTile`: both of its data sources resolve through the bound host's own
 * client, so an app-active-host mismatch is not a reason to blank the tile.
 */
export function PrDiffTile(props: PrDiffTileProps): ReactNode {
  const tabHostId = useTabHostId();
  const reachability = useHostReachability(tabHostId);

  if (reachability.status === "unreachable") {
    return (
      <PrDetailDeadTileBanner
        hostLabel={reachability.hostLabel}
        testId={`pr-diff-tile-${props.node.id}`}
      />
    );
  }

  return (
    <PrDiffTileLive
      node={props.node}
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      isActive={props.isActive}
    />
  );
}

/** What the toolbar/header need to know about whichever range resolved. */
interface PrDiffRangeMeta {
  readonly resolvedBaseRef: string;
  readonly filePaths: readonly string[];
}

interface PrLocalDiffTileData {
  readonly summaryQuery: UseQueryResult<
    PrGetLocalDiffSummaryResponse,
    HostRpcError
  >;
  readonly monolithQuery: UseQueryResult<PrGetLocalDiffResponse, HostRpcError>;
  readonly summaryUnsupported: boolean;
  /**
   * The summary response the tile may ACT on - `null` whenever the summary
   * query's latest answer was `E_HOST_UNSUPPORTED`, even though TanStack
   * retains the previously-successful `data` beside that error. Without this
   * suppression a mid-session host DOWNGRADE would leave a populated tile in
   * split mode forever: the stale summary keeps rendering, every section
   * keeps calling the now-missing per-file method, and the monolith fallback
   * is fetched but never read.
   */
  readonly summaryData: PrGetLocalDiffSummaryResponse | null;
  /**
   * The monolith response the tile may ACT on - `null` outside fallback
   * mode. Gated HERE beside `summaryData`'s suppression so the two halves
   * of the one mode rule cannot diverge.
   */
  readonly monolithData: PrGetLocalDiffResponse | null;
  readonly range: PrDiffRangeMeta | null;
  readonly isPending: boolean;
}

/**
 * The tile's two-stage data source. Call-and-degrade: the summary call IS the
 * feature detection - on a host that predates the split methods it fails
 * `E_HOST_UNSUPPORTED` (the negotiated-manifest registry can't answer from
 * render on a fresh tile; see the hook's note), and only then does the tile
 * pay for the whole-PR monolith.
 */
function usePrLocalDiffTileData(args: {
  readonly target: PrLocalDiffTarget | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): PrLocalDiffTileData {
  const summaryQuery = usePrLocalDiffSummaryQuery(args);
  const summaryUnsupported = isHostUnsupportedError(summaryQuery.error);
  const monolithQuery = usePrLocalDiffQuery({
    target: args.target,
    ignoreWhitespace: args.ignoreWhitespace,
    enabled: args.enabled && summaryUnsupported,
  });

  const summaryData = summaryUnsupported ? null : (summaryQuery.data ?? null);
  const monolithData = summaryUnsupported ? (monolithQuery.data ?? null) : null;
  const range = useMemo(
    () => resolvedRangeMeta(summaryData, monolithData, summaryUnsupported),
    [summaryData, monolithData, summaryUnsupported],
  );
  const isPending = summaryUnsupported
    ? monolithQuery.isPending
    : summaryQuery.isPending;
  return {
    summaryQuery,
    monolithQuery,
    summaryUnsupported,
    summaryData,
    monolithData,
    range,
    isPending,
  };
}

/**
 * The per-file entries an invalidation may refetch: an `unavailable` answer
 * (a statement about mutable repo state) or an errored query. A
 * `kind: "diff"` entry is OID-immutable - refetching it can only return the
 * same bytes - so a broad invalidation would reissue every visible patch for
 * nothing.
 */
function isMutableFileDiffEntry(query: Query): boolean {
  if (query.state.status === "error") return true;
  const data: unknown = query.state.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    data.kind === "unavailable"
  );
}

/** The OID pair naming a resolved summary range, for drift-recovery gating. */
function summaryRangeKey(
  summary: PrGetLocalDiffSummaryResponse | null,
): string | null {
  if (summary?.kind !== "summary") return null;
  return `${summary.mergeBaseOid}..${summary.localHeadOid}`;
}

/** The toolbar's collapse-all model, or `null` before any range resolved. */
function collapseAllFor(
  range: PrDiffRangeMeta | null,
  collapsedFilePaths: ReadonlyArray<string>,
): { allCollapsed: boolean; filePaths: readonly string[] } | null {
  if (range === null || range.filePaths.length === 0) return null;
  return {
    allCollapsed: range.filePaths.every((path) =>
      collapsedFilePaths.includes(path),
    ),
    filePaths: range.filePaths,
  };
}

function resolvedRangeMeta(
  summary: PrGetLocalDiffSummaryResponse | null,
  monolith: PrGetLocalDiffResponse | null,
  summaryUnsupported: boolean,
): PrDiffRangeMeta | null {
  if (summary?.kind === "summary") {
    return {
      resolvedBaseRef: summary.resolvedBaseRef,
      filePaths: summary.files.map((file) => file.path),
    };
  }
  if (summaryUnsupported && monolith?.kind === "diff") {
    return {
      resolvedBaseRef: monolith.resolvedBaseRef,
      filePaths: monolith.files.map((file) => file.path),
    };
  }
  return null;
}

function PrDiffTileLive(props: PrDiffTileProps): ReactNode {
  const { node } = props;
  const tabHostId = useTabHostId();
  const queryClient = useQueryClient();
  const preferences = useSettingsStore((state) => state.diffViewerPreferences);
  const patchPreferences = useSettingsStore(
    (state) => state.patchDiffViewerPreferences,
  );
  const updateView = useEpicCanvasStore(
    (state) => state.updatePrDiffTileViewInTab,
  );

  // The range is re-derived from the detail stream rather than frozen into the
  // tile: a tile reopened after a force-push must diff what the PR IS, not
  // replay a range that no longer exists.
  const subscription = usePrDetailSubscription({
    epicId: props.epicId,
    githubHost: node.githubHost,
    owner: node.owner,
    repo: node.repo,
    prNumber: node.prNumber,
    enabled: props.isActive,
  });
  const core = subscription.data?.core ?? null;
  // Memoized for IDENTITY, not cost: `invalidateFileDiffs` and through it
  // `handleRangeDrift` and the sections' drift-report effects all key on
  // this object. Rebuilt per render, every summary fetch-state flip would
  // mint new callbacks and re-arm those effects - which is exactly the
  // re-entry loop a failed drift recovery must not have.
  const { epicId } = props;
  const target = useMemo(
    () => (core === null ? null : prLocalDiffTarget(core, epicId)),
    [core, epicId],
  );
  const {
    summaryQuery,
    monolithQuery,
    summaryUnsupported,
    summaryData,
    monolithData,
    range,
    isPending,
  } = usePrLocalDiffTileData({
    target,
    ignoreWhitespace: preferences.ignoreWhitespace,
    enabled: props.isActive,
  });

  // "Clear the MUTABLE per-file answers under this PR's checkout" - the
  // refresh and drift-recovery escape hatch for cached `unavailable`/errored
  // file entries. Filtered by {@link isMutableFileDiffEntry} so it never
  // re-fans-out every visible OID-immutable patch.
  const invalidateFileDiffs = useCallback((): void => {
    if (target === null) return;
    void queryClient.invalidateQueries({
      queryKey: prQueryKeys.localFileDiffScope({
        hostId: tabHostId,
        epicId: target.epicId,
        linkGroupKey: target.linkGroupKey,
        owner: target.repoIdentifier.owner,
        repo: target.repoIdentifier.repo,
        repoRole: target.repoRole,
      }),
      predicate: isMutableFileDiffEntry,
    });
  }, [queryClient, tabHostId, target]);

  const toolbarView = useMemo<DiffTabToolbarView>(
    () => ({
      ...preferences,
      collapsedFilePaths: node.view.collapsedFilePaths,
    }),
    [preferences, node.view.collapsedFilePaths],
  );

  const handleViewPatch = useCallback(
    (patch: DiffTabToolbarViewPatch): void => {
      if ("collapsedFilePaths" in patch) {
        updateView(props.viewTabId, node.id, {
          ...node.view,
          collapsedFilePaths: patch.collapsedFilePaths,
        });
        return;
      }
      patchPreferences(patch);
    },
    [node.id, node.view, patchPreferences, props.viewTabId, updateView],
  );

  const { refetch: refetchSummary } = summaryQuery;
  const { refetch: refetchMonolith } = monolithQuery;
  const handleRefresh = useCallback((): void => {
    // The summary is the tile's spine: refetching it re-resolves the range,
    // and new OIDs re-key every per-file query on their own. Same-OID
    // refreshes additionally invalidate the MUTABLE per-file entries
    // (unavailable/errored - the answers that describe repo state a refresh
    // exists to re-read), sequenced after the summary settles so the
    // re-asks never race the range resolution. In fallback mode the monolith
    // is the spine instead.
    if (summaryUnsupported) {
      void refetchMonolith();
      return;
    }
    void refetchSummary().then(() => {
      invalidateFileDiffs();
    });
  }, [
    invalidateFileDiffs,
    refetchMonolith,
    refetchSummary,
    summaryUnsupported,
  ]);

  // Bounded range-drift recovery: when a per-file call reports the checkout
  // no longer has the summary's OIDs, refetch the summary ONCE per named
  // range. The ref (not state) is deliberate - a burst of sections reporting
  // the same dead range must collapse into one refetch, and a range that
  // keeps dying must not loop. Two outcomes need explicit handling on top of
  // that: a FAILED refetch releases the token (a transient failure must not
  // spend the range's one recovery), and a refetch that resolves the SAME
  // OIDs invalidates the per-file scope, because the sections' cached
  // `unavailable` answers would otherwise sit un-rekeyed forever.
  const recoveredRangeRef = useRef<string | null>(null);
  // The token bounds one continuous EPISODE of a range, not the range's OID
  // pair forever: leaving A for B and force-pushing back to A serves A's
  // still-cached summary and per-file answers, and a spent token from A's
  // first episode would silently suppress the new episode's one recovery.
  // `episodeRangeRef` names the episode the token belongs to. It is opened in
  // TWO places because of effect ordering: the returning range's remounted
  // sections report drift from their own effects, which run BEFORE this
  // component's - so the handler opens an unseen episode lazily (voiding a
  // previous episode's spent token), and the effect below records
  // report-free range changes so an excursion the sections never reported
  // still closes the old episode.
  const episodeRangeRef = useRef<string | null>(null);
  const rangeKey = summaryRangeKey(summaryData);
  const handleRangeDrift = useCallback((): void => {
    if (rangeKey === null) return;
    if (episodeRangeRef.current !== rangeKey) {
      episodeRangeRef.current = rangeKey;
      recoveredRangeRef.current = null;
    }
    if (recoveredRangeRef.current === rangeKey) return;
    recoveredRangeRef.current = rangeKey;
    void refetchSummary().then((result) => {
      if (result.error !== null) {
        recoveredRangeRef.current = null;
        return;
      }
      invalidateFileDiffs();
    });
  }, [invalidateFileDiffs, refetchSummary, rangeKey]);
  useEffect(() => {
    if (episodeRangeRef.current === rangeKey) return;
    episodeRangeRef.current = rangeKey;
    recoveredRangeRef.current = null;
  }, [rangeKey]);

  const collapseAll = collapseAllFor(range, node.view.collapsedFilePaths);
  const header = prDiffTileHeader(node, core, range);

  return (
    <DiffTabShell
      primaryTitle={header.primaryTitle}
      secondaryLine={header.secondaryLine}
      contextLabel={null}
      toolbar={
        <DiffTabToolbar
          view={toolbarView}
          onViewPatch={handleViewPatch}
          collapseAll={collapseAll}
          refreshing={summaryQuery.isFetching || monolithQuery.isFetching}
          onRefresh={handleRefresh}
          // No editor-open row: a PR diff spans many files and the range's
          // endpoints are commits, so there is no single path to hand an
          // editor. The per-file sections keep their own affordances.
          onOpenFile={null}
          openFileDisabled={false}
          openFileOpening={false}
        />
      }
    >
      {subscription.isPending || (target !== null && isPending) ? (
        <DiffBundleLoadingSkeleton mode={preferences.mode} />
      ) : (
        <PrLocalDiffBody
          node={node}
          viewTabId={props.viewTabId}
          target={target}
          summary={summaryData}
          monolith={monolithData}
          onRangeDrift={handleRangeDrift}
          prUrl={core?.prUrl ?? null}
          preferences={preferences}
        />
      )}
    </DiffTabShell>
  );
}

/**
 * Shell title lines. Before the range resolves, both lines fall back to the
 * PR's coordinates - the one identity that is known from the tile ref alone,
 * so a tile rendered from persisted state never flashes an empty header while
 * the detail stream connects.
 */
function prDiffTileHeader(
  node: PrDiffTileRef,
  core: PrDetailCore | null,
  range: PrDiffRangeMeta | null,
): { readonly primaryTitle: string; readonly secondaryLine: string } {
  const coordinates = `${node.owner}/${node.repo}#${node.prNumber}`;
  if (range === null) {
    return {
      primaryTitle: core?.title ?? coordinates,
      secondaryLine: coordinates,
    };
  }
  const count = range.filePaths.length;
  const fileCount = `${count} file${count === 1 ? "" : "s"}`;
  const head = core?.headRefName ?? "head";
  return {
    primaryTitle: core?.title ?? coordinates,
    secondaryLine: `${range.resolvedBaseRef} … ${head} · ${fileCount}`,
  };
}
