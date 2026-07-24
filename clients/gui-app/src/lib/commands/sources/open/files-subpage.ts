/**
 * Opener "Files" sub-page (two-step): step 1 picks a source - the always-present
 * `Artifacts` source plus every browsable attached workspace/worktree -
 * and step 2 fuzz-searches that source's logical paths through the host
 * `workspace.searchPaths` RPC (host `rg --files` enumeration + Fuse ranking),
 * NOT a full renderer-side tree download + substring filter.
 *
 * There is no single-workspace shortcut: `Artifacts` is a first-class
 * source, so auto-skipping to a lone workspace would hide it. A code result
 * opens as a `WorkspaceFileRef`; an artifact result is resolved against the
 * authoritative open-epic Yjs projection and opens as an `EpicArtifactRef`
 * (stale/deleted disk results resolve to nothing and are dropped).
 *
 * The pane opener disables cmdk filtering for the result step so host Fuse
 * ranking, typo-tolerant matches, and search-state notices are preserved. The
 * source-picker step and unrelated opener pages keep cmdk filtering enabled.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import type { WorkspaceSearchSource } from "@traycer/protocol/host/workspace/unary-schemas";
import { getBasename } from "@/lib/path/cross-platform-path";
import { useHostClient } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  readSearchPathsResponseForSource,
  useWorkspaceSearchPathsForSource,
  type WorkspaceSearchPathsView,
} from "@/hooks/workspace/use-workspace-search-paths-query";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import {
  buildArtifactDisplayPathIndex,
  normalizeArtifactLogicalPath,
  type ArtifactPathEntry,
} from "@/lib/commands/sources/open/artifact-display-index";
import {
  filesArtifactsResultSubpageId,
  filesCodeRootResultSubpageId,
} from "@/lib/commands/sources/open/files-result-subpage";
import {
  openerActionLeaf,
  openerSubpageLeaf,
  openerTruncatedHint,
} from "@/lib/commands/sources/open/open-leaf";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

const FILES_SEARCH_DEBOUNCE_MS = 150;

// A stable source object so the search hook's query key is stable across
// renders (the host derives the mirror root from the request `epicId`).
const EPIC_ARTIFACTS_SOURCE: WorkspaceSearchSource = { kind: "epic-artifacts" };

const EMPTY_ARTIFACT_PATH_INDEX: ReadonlyMap<string, ArtifactPathEntry> =
  new Map();

/**
 * Non-actionable notice row for a distinct non-`ready` state (an unavailable
 * source, or a host without the search RPC). Keyed per-category so it never
 * collides with a result row.
 */
function openerNotice(id: string, label: string): CommandItem {
  return {
    id,
    label,
    description: null,
    keywords: [],
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => undefined,
  };
}

// --- Step 2a: code workspace/worktree root ---------------------------------

interface CodeFileLeavesArgs {
  readonly ctx: CommandContext;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly view: WorkspaceSearchPathsView | null;
  readonly isError: boolean;
}

function codeFileLeaves(args: CodeFileLeavesArgs): ReadonlyArray<CommandItem> {
  const { ctx, hostId, workspacePath, view, isError } = args;
  if (isError) {
    return [
      openerNotice(
        `open:files:ws:${workspacePath}:unsupported`,
        "File search is unavailable on this host",
      ),
    ];
  }
  // No usable response yet (loading, or a late reply for a different source).
  if (view === null) return [];
  if (view.outcome === "root_unavailable") {
    return [
      openerNotice(
        `open:files:ws:${workspacePath}:unavailable`,
        "This workspace is unavailable",
      ),
    ];
  }
  const leaves = view.results.flatMap((result) => {
    if (result.kind !== "file") return [];
    return [
      openerActionLeaf({
        id: `open:files:${workspacePath}:${result.relPath}`,
        // Workspace-relative path so duplicate basenames are distinguishable,
        // and so the host-searched text is what cmdk re-filters on.
        label: result.relPath,
        keywords: [result.relPath, result.name],
        run: () => {
          const ref = workspaceFileRefFromTreePath(
            hostId,
            workspacePath,
            result.relPath,
            result.name,
          );
          if (ref === null) return;
          openTileIntoTargetGroup({
            tabId: ctx.activeTabId,
            groupId: ctx.targetGroupId,
            ref,
            navigateNestedFocus: ctx.router.navigateNestedFocus,
          });
        },
      }),
    ];
  });
  return view.truncated
    ? [...leaves, openerTruncatedHint("files", leaves.length)]
    : leaves;
}

function useCodeRootStepItems(
  ctx: CommandContext,
  row: WorktreeBindingSelectorRow,
): ReadonlyArray<CommandItem> {
  const client = useHostClient();
  const query = usePaletteLiveQuery();
  const debouncedQuery = useDebouncedValue(query, FILES_SEARCH_DEBOUNCE_MS);
  const epicId = ctx.activeEpicId ?? "";
  const source = useMemo<WorkspaceSearchSource>(
    () => ({ root: row.runningDir }),
    [row.runningDir],
  );
  const search = useWorkspaceSearchPathsForSource({
    client,
    epicId,
    source,
    query: debouncedQuery,
    kinds: "files",
    enabled: ctx.activeEpicId !== null,
  });
  const view = readSearchPathsResponseForSource(search.data, epicId, source);
  const isError = search.isError;
  return useMemo<ReadonlyArray<CommandItem>>(
    () =>
      codeFileLeaves({
        ctx,
        hostId: row.hostId,
        workspacePath: row.runningDir,
        view,
        isError,
      }),
    [ctx, row.hostId, row.runningDir, view, isError],
  );
}

function makeCodeRootStepSubpage(
  row: WorktreeBindingSelectorRow,
): CommandSubpage {
  return {
    id: filesCodeRootResultSubpageId(row.hostId, row.runningDir),
    title: getBasename(row.runningDir),
    useItems: (ctx) => useCodeRootStepItems(ctx, row),
  };
}

// --- Step 2b: Artifacts ----------------------------------------------------

interface ArtifactLeavesArgs {
  readonly ctx: CommandContext;
  readonly defaultHostId: string;
  readonly view: WorkspaceSearchPathsView | null;
  readonly isError: boolean;
  readonly pathIndex: ReadonlyMap<string, ArtifactPathEntry>;
}

function artifactLeaves(args: ArtifactLeavesArgs): ReadonlyArray<CommandItem> {
  const { ctx, defaultHostId, view, isError, pathIndex } = args;
  if (isError) {
    return [
      openerNotice(
        "open:files:artifacts:unsupported",
        "Artifact search is unavailable on this host",
      ),
    ];
  }
  if (view === null) return [];
  if (view.outcome === "root_unavailable") {
    return [
      openerNotice(
        "open:files:artifacts:unavailable",
        "Artifacts are unavailable",
      ),
    ];
  }
  const leaves = view.results.flatMap((result) => {
    if (result.kind !== "file") return [];
    // Resolve the host logical path against authoritative Yjs state; a
    // deleted/renamed/not-yet-projected artifact is absent → drop the row.
    const entry = pathIndex.get(normalizeArtifactLogicalPath(result.relPath));
    if (entry === undefined) return [];
    const ref: EpicArtifactRef = {
      id: entry.id,
      instanceId: uuidv4(),
      type: entry.kind,
      name: entry.title,
      hostId: defaultHostId,
    };
    return [
      openerActionLeaf({
        id: `open:files:artifacts:${entry.id}`,
        // Ancestor-title path distinguishes duplicate leaf titles and reads
        // better than the folder slug; the slug path rides in keywords so the
        // host match survives cmdk's re-filter.
        label: entry.titlePath.length > 0 ? entry.titlePath : entry.title,
        keywords: [result.relPath, result.name, entry.title, entry.titlePath],
        run: () => {
          openTileIntoTargetGroup({
            tabId: ctx.activeTabId,
            groupId: ctx.targetGroupId,
            ref,
            navigateNestedFocus: ctx.router.navigateNestedFocus,
          });
        },
      }),
    ];
  });
  return view.truncated
    ? [...leaves, openerTruncatedHint("files-artifacts", leaves.length)]
    : leaves;
}

function useArtifactsStepItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const client = useHostClient();
  const defaultHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const query = usePaletteLiveQuery();
  const debouncedQuery = useDebouncedValue(query, FILES_SEARCH_DEBOUNCE_MS);
  const epicId = ctx.activeEpicId ?? "";
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  const search = useWorkspaceSearchPathsForSource({
    client,
    epicId,
    source: EPIC_ARTIFACTS_SOURCE,
    query: debouncedQuery,
    kinds: "files",
    enabled: ctx.activeEpicId !== null,
  });
  const view = readSearchPathsResponseForSource(
    search.data,
    epicId,
    EPIC_ARTIFACTS_SOURCE,
  );
  const isError = search.isError;
  const pathIndex = useMemo(
    () =>
      projection === null
        ? EMPTY_ARTIFACT_PATH_INDEX
        : buildArtifactDisplayPathIndex(projection.tree, projection.artifacts),
    [projection],
  );
  return useMemo<ReadonlyArray<CommandItem>>(
    () => artifactLeaves({ ctx, defaultHostId, view, isError, pathIndex }),
    [ctx, defaultHostId, view, isError, pathIndex],
  );
}

const ARTIFACTS_STEP_SUBPAGE: CommandSubpage = {
  id: filesArtifactsResultSubpageId(),
  title: "Artifacts",
  useItems: useArtifactsStepItems,
};

// --- Step 1: source list ----------------------------------------------------

export function useFilesOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: ctx.activeEpicId ?? "",
    enabled: ctx.activeEpicId !== null,
  });
  const workspaceRoots = useMemo(
    () => bindingsQuery.data?.rows.filter(isBrowsable) ?? [],
    [bindingsQuery.data?.rows],
  );
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (ctx.activeEpicId === null) return [];
    // `Artifacts` is always offered (even for an Epic with no attached
    // code workspace); the old single-workspace shortcut is gone because it
    // would hide this source.
    return [
      openerSubpageLeaf({
        id: filesArtifactsResultSubpageId(),
        label: "Artifacts",
        keywords: ["artifact", "spec", "ticket", "story", "review"],
        subpage: ARTIFACTS_STEP_SUBPAGE,
      }),
      ...workspaceRoots.map((row) =>
        openerSubpageLeaf({
          id: filesCodeRootResultSubpageId(row.hostId, row.runningDir),
          label: getBasename(row.runningDir),
          keywords: [row.runningDir],
          subpage: makeCodeRootStepSubpage(row),
        }),
      ),
    ];
  }, [ctx.activeEpicId, workspaceRoots]);
}
