/**
 * Opener "Files" sub-page (two-step): step 1 picks a linked workspace, step 2
 * fuzzes the workspace file tree. A single-workspace epic skips straight to the
 * file step. The chosen file opens into the target group as a WorkspaceFileRef.
 *
 * Large-tree handling: the host caps the tree at 25k entries (response
 * `truncated`); we additionally substring-filter by the live palette query and
 * render only the top `OPENER_RESULT_CAP` rows so the sub-page stays
 * responsive, appending a hint row when results are capped.
 */
import { useMemo } from "react";
import { getBasename } from "@/lib/path/cross-platform-path";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { useWorkspaceListFileTree } from "@/hooks/workspace/use-list-file-tree-query";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import { matchesPathQuery } from "@/lib/commands/path-query";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import {
  OPENER_RESULT_CAP,
  openerActionLeaf,
  openerSubpageLeaf,
  openerTruncatedHint,
} from "@/lib/commands/sources/open/open-leaf";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";

interface FileNode {
  readonly path: string;
  readonly name: string;
}

interface FileLeavesArgs {
  readonly ctx: CommandContext;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly files: ReadonlyArray<FileNode>;
  readonly truncated: boolean;
  readonly query: string;
}

function fileLeaves(args: FileLeavesArgs): ReadonlyArray<CommandItem> {
  const { ctx, hostId, workspacePath, files, truncated, query } = args;
  const matched = files.filter((file) => matchesPathQuery(query, file.path));
  const shown = matched.slice(0, OPENER_RESULT_CAP);
  const leaves = shown.map((file) =>
    openerActionLeaf({
      id: `open:files:${workspacePath}:${file.path}`,
      // Workspace-relative path (not just `file.name`) so duplicate basenames
      // are distinguishable; the row dims the directory, emphasizes the name.
      label: file.path,
      keywords: [file.path],
      run: () => {
        const ref = workspaceFileRefFromTreePath(
          hostId,
          workspacePath,
          file.path,
          file.name,
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
  );
  if (truncated || matched.length > shown.length) {
    return [...leaves, openerTruncatedHint("files", shown.length)];
  }
  return leaves;
}

function useFilesStepItems(
  ctx: CommandContext,
  row: WorktreeBindingSelectorRow,
): ReadonlyArray<CommandItem> {
  const tree = useWorkspaceListFileTree(row.runningDir);
  const query = usePaletteLiveQuery();
  const data = tree.data;
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (data === undefined) return [];
    return fileLeaves({
      ctx,
      hostId: row.hostId,
      workspacePath: row.runningDir,
      files: data.files,
      truncated: data.truncated,
      query,
    });
  }, [ctx, row.hostId, row.runningDir, data, query]);
}

function makeFilesStepSubpage(row: WorktreeBindingSelectorRow): CommandSubpage {
  return {
    id: `open:files:ws:${row.hostId}:${encodeURIComponent(row.runningDir)}`,
    title: getBasename(row.runningDir),
    useItems: (ctx) => useFilesStepItems(ctx, row),
  };
}

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
  // Single-workspace epics skip the workspace step. The file-tree hook is
  // called unconditionally (null = disabled) to keep the hook order stable.
  const singleRow = workspaceRoots.length === 1 ? workspaceRoots[0] : null;
  const singlePath = singleRow === null ? null : singleRow.runningDir;
  const singleTree = useWorkspaceListFileTree(singlePath);
  const query = usePaletteLiveQuery();
  const singleData = singleTree.data;
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (singleRow !== null) {
      if (singleData === undefined) return [];
      return fileLeaves({
        ctx,
        hostId: singleRow.hostId,
        workspacePath: singleRow.runningDir,
        files: singleData.files,
        truncated: singleData.truncated,
        query,
      });
    }
    return workspaceRoots.map((row) =>
      openerSubpageLeaf({
        id: `open:files:ws:${row.hostId}:${encodeURIComponent(row.runningDir)}`,
        label: getBasename(row.runningDir),
        keywords: [row.runningDir],
        subpage: makeFilesStepSubpage(row),
      }),
    );
  }, [ctx, workspaceRoots, singleRow, singleData, query]);
}
