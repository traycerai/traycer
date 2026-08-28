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
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  readSearchPathsResponseForSource,
  useWorkspaceSearchPathsForSource,
  type WorkspaceSearchPathsView,
} from "@/hooks/workspace/use-workspace-search-paths-query";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import {
  useActiveEpicHostId,
  useActiveEpicProjection,
} from "@/lib/commands/sources/open/use-active-epic-projection";
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
import {
  buildRankedPathItems,
  buildPathTreeItems,
  openerPathTreeId,
} from "@/lib/commands/sources/open/path-tree-items";
import { useWorkspaceFileListSubscription } from "@/hooks/workspace/use-workspace-file-list-subscription";
import {
  useOpenerFileTreeExpandedPaths,
  useOpenerFileTreeStore,
} from "@/stores/file-tree/opener-file-tree-store";

const FILES_SEARCH_DEBOUNCE_MS = 150;
const WORKSPACE_FILE_LIST_METHOD = "workspace.subscribeFileList";

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
    disabled: true,
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
      {
        path: result.relPath,
        displaySegments: null,
        structuralSegments: null,
        gitStatus: undefined,
        item: openerActionLeaf({
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
      },
    ];
  });
  const treeItems = buildRankedPathItems(
    openerPathTreeId("files", hostId, workspacePath),
    leaves,
  );
  return view.truncated
    ? [...treeItems, openerTruncatedHint("files", leaves.length)]
    : treeItems;
}

function liveCodeFileLeaves(args: {
  readonly ctx: CommandContext;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly paths: ReadonlyArray<string>;
  readonly fileNameByPath: ReadonlyMap<string, string>;
  readonly truncated: boolean;
}): ReadonlyArray<CommandItem> {
  const treeId = openerPathTreeId("files", args.hostId, args.workspacePath);
  const leaves = [...args.fileNameByPath].map(([path, name]) => ({
    path,
    displaySegments: null,
    structuralSegments: null,
    gitStatus: undefined,
    item: openerActionLeaf({
      id: `open:files:${args.workspacePath}:${path}`,
      label: path,
      keywords: [path, name],
      run: () => {
        const ref = workspaceFileRefFromTreePath(
          args.hostId,
          args.workspacePath,
          path,
          name,
        );
        if (ref === null) return;
        openTileIntoTargetGroup({
          tabId: args.ctx.activeTabId,
          groupId: args.ctx.targetGroupId,
          ref,
          navigateNestedFocus: args.ctx.router.navigateNestedFocus,
        });
      },
    }),
  }));
  const directories = args.paths.filter((path) => path.endsWith("/"));
  const items = buildPathTreeItems(treeId, leaves, directories);
  return args.truncated
    ? [...items, openerTruncatedHint("files", leaves.length)]
    : items;
}

function useCodeRootStepItems(
  ctx: CommandContext,
  row: WorktreeBindingSelectorRow,
): ReadonlyArray<CommandItem> {
  // The row names the host that owns this workspace root; the file search
  // runs there, on the same host the leaves below bind their tiles to.
  const client = useHostClientForHostId(row.hostId);
  const query = usePaletteLiveQuery();
  const isBrowsing = query.trim().length === 0;
  const hostEntry = useHostDirectoryEntry(row.hostId);
  const streamAuth = useStreamAuthRevalidator();
  const streamClient = useHostStreamClientFor(
    isBrowsing ? hostEntry : null,
    streamAuth,
  );
  const streamSupport = useStreamMethodSupportFor(
    streamClient,
    WORKSPACE_FILE_LIST_METHOD,
  );
  const debouncedQuery = useDebouncedValue(query, FILES_SEARCH_DEBOUNCE_MS);
  const epicId = ctx.activeEpicId ?? "";
  const source = useMemo<WorkspaceSearchSource>(
    () => ({ root: row.runningDir }),
    [row.runningDir],
  );
  const treeId = openerPathTreeId("files", row.hostId, row.runningDir);
  const expandedPaths = useOpenerFileTreeExpandedPaths(treeId);
  const prune = useOpenerFileTreeStore((state) => state.prune);
  const onPruned = (directoryPaths: ReadonlyArray<string>) => {
    prune(treeId, directoryPaths);
  };
  const live = useWorkspaceFileListSubscription({
    epicId,
    hostId: row.hostId,
    workspacePath: row.runningDir,
    enabled:
      ctx.activeEpicId !== null &&
      isBrowsing &&
      streamClient !== null &&
      streamSupport !== "unsupported",
    streamClient,
    expandedPathsOverride: expandedPaths,
    onPrunedOverride: onPruned,
  });
  const search = useWorkspaceSearchPathsForSource({
    client,
    epicId,
    source,
    query: debouncedQuery,
    kinds: "files",
    enabled: ctx.activeEpicId !== null && query.trim().length > 0,
  });
  const view = readSearchPathsResponseForSource(search.data, epicId, source);
  const isError = search.isError;
  if (query.trim().length > 0) {
    return codeFileLeaves({
      ctx,
      hostId: row.hostId,
      workspacePath: row.runningDir,
      view,
      isError,
    });
  }
  if (streamClient === null || streamSupport === "unsupported") {
    return [
      openerNotice(
        `open:files:ws:${row.runningDir}:browse-unavailable`,
        "File browsing is unavailable on this host",
      ),
    ];
  }
  if (live.error !== null) {
    return [
      openerNotice(
        `open:files:ws:${row.runningDir}:browse-error`,
        "Files could not be loaded",
      ),
    ];
  }
  if (live.isPending) {
    return [
      openerNotice(
        `open:files:ws:${row.runningDir}:browse-loading`,
        "Loading files…",
      ),
    ];
  }
  return liveCodeFileLeaves({
    ctx,
    hostId: row.hostId,
    workspacePath: row.runningDir,
    paths: live.paths,
    fileNameByPath: live.fileNameByPath,
    truncated: live.truncated,
  });
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
  readonly isSearching: boolean;
}

function artifactLeaves(args: ArtifactLeavesArgs): ReadonlyArray<CommandItem> {
  const { ctx, defaultHostId, view, isError, pathIndex, isSearching } = args;
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
    return [
      {
        path: entry.id,
        displaySegments: entry.titleSegments,
        structuralSegments: entry.idSegments,
        gitStatus: undefined,
        item: openerActionLeaf({
          id: `open:files:artifacts:${entry.id}`,
          // Ancestor-title path distinguishes duplicate leaf titles and reads
          // better than the folder slug; the slug path rides in keywords so the
          // host match survives cmdk's re-filter.
          label: entry.titlePath.length > 0 ? entry.titlePath : entry.title,
          keywords: [result.relPath, result.name, entry.title, entry.titlePath],
          run: () => {
            const ref: EpicArtifactRef = {
              id: entry.id,
              instanceId: uuidv4(),
              type: entry.kind,
              name: entry.title,
              hostId: defaultHostId,
            };
            openTileIntoTargetGroup({
              tabId: ctx.activeTabId,
              groupId: ctx.targetGroupId,
              ref,
              navigateNestedFocus: ctx.router.navigateNestedFocus,
            });
          },
        }),
      },
    ];
  });
  const treeId = `open:files:artifacts:${ctx.activeEpicId ?? ""}`;
  const treeItems = isSearching
    ? buildRankedPathItems(treeId, leaves)
    : buildPathTreeItems(treeId, leaves, []);
  return view.truncated
    ? [...treeItems, openerTruncatedHint("files-artifacts", leaves.length)]
    : treeItems;
}

function useArtifactsStepItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  // The epic's artifacts live on (and their tiles bind to) the host serving
  // the epic's projection - see `useActiveEpicHostId`.
  const activeEpicHostId = useActiveEpicHostId(ctx.activeEpicId);
  const client = useHostClientForHostId(activeEpicHostId);
  const defaultHostId = activeEpicHostId ?? UNKNOWN_HOST_PLACEHOLDER;
  const query = usePaletteLiveQuery();
  const isSearching = query.trim().length > 0;
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
    () =>
      artifactLeaves({
        ctx,
        defaultHostId,
        view,
        isError,
        pathIndex,
        isSearching,
      }),
    [ctx, defaultHostId, view, isError, pathIndex, isSearching],
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
  // The epic's worktree bindings are host-local records of the host serving
  // the epic - read them there, not from whichever host the app points at.
  const activeEpicHostId = useActiveEpicHostId(ctx.activeEpicId);
  const bindingsQuery = useWorktreeListBindingsForEpicForClient({
    client: useHostClientForHostId(activeEpicHostId),
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
