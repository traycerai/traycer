import { useCallback, useMemo, type ReactNode } from "react";
import type {
  PrDetailCore,
  PrGetLocalDiffResponse,
} from "@traycer/protocol/host/pr-schemas";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { usePrDetailSubscription } from "@/hooks/pr/use-pr-detail-subscription";
import {
  prLocalDiffTarget,
  usePrLocalDiffQuery,
} from "@/hooks/pr/use-pr-local-diff";
import { DiffTabShell } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import {
  DiffTabToolbar,
  type DiffTabToolbarView,
  type DiffTabToolbarViewPatch,
} from "@/components/epic-canvas/git-diff/diff-tab-toolbar";
import { DiffBundleLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-bundle-loading-skeleton";
import { PrLocalDiffBody } from "@/components/epic-canvas/pr/pr-local-diff-body";
import { PrDetailDeadTileBanner } from "./dead-tile-banner";

type PrLocalDiffSuccess = Extract<PrGetLocalDiffResponse, { kind: "diff" }>;

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

function PrDiffTileLive(props: PrDiffTileProps): ReactNode {
  const { node } = props;
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
  const target = core === null ? null : prLocalDiffTarget(core, props.epicId);
  const localDiff = usePrLocalDiffQuery({
    target,
    ignoreWhitespace: preferences.ignoreWhitespace,
    enabled: props.isActive,
  });

  const diff = localDiff.data?.kind === "diff" ? localDiff.data : null;
  const filePaths = useMemo(
    () => (diff === null ? [] : diff.files.map((file) => file.path)),
    [diff],
  );

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

  const { refetch } = localDiff;
  const handleRefresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  const collapseAll =
    filePaths.length === 0
      ? null
      : {
          allCollapsed: filePaths.every((path) =>
            node.view.collapsedFilePaths.includes(path),
          ),
          filePaths,
        };

  const header = prDiffTileHeader(node, core, diff);

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
          refreshing={localDiff.isFetching}
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
      {subscription.isPending || (target !== null && localDiff.isPending) ? (
        <DiffBundleLoadingSkeleton mode={preferences.mode} />
      ) : (
        <PrLocalDiffBody
          node={node}
          viewTabId={props.viewTabId}
          result={localDiff.data ?? null}
          hasTarget={target !== null}
          isError={localDiff.error !== null}
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
  diff: PrLocalDiffSuccess | null,
): { readonly primaryTitle: string; readonly secondaryLine: string } {
  const coordinates = `${node.owner}/${node.repo}#${node.prNumber}`;
  if (diff === null) {
    return {
      primaryTitle: core?.title ?? coordinates,
      secondaryLine: coordinates,
    };
  }
  const fileCount = `${diff.files.length} file${diff.files.length === 1 ? "" : "s"}`;
  const head = core?.headRefName ?? "head";
  return {
    primaryTitle: core?.title ?? coordinates,
    secondaryLine: `${diff.resolvedBaseRef} … ${head} · ${fileCount}`,
  };
}
