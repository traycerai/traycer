/**
 * Opener "Diff" sub-page (two-step): step 1 picks a linked git workspace, step
 * 2 fuzzes that workspace's changed files. A single git-workspace epic skips
 * straight to the changed-file step. The chosen file opens into the target
 * group as a GitDiffTileRef. Non-git workspaces are excluded (no changes to
 * diff). Snapshot diffs stay programmatic (out of scope).
 *
 * Large-list handling mirrors the Files sub-page: substring-filter by the live
 * palette query, render the top `OPENER_RESULT_CAP` rows, append a hint when
 * capped.
 */
import { useMemo } from "react";
import { getBasename } from "@/lib/path/cross-platform-path";
import type {
  GitChangedFile,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import { useGitListChangedFilesSubscription } from "@/hooks/git/use-git-list-changed-files-subscription";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";
import { makeGitFileDiffTileForFile } from "@/lib/git/git-diff-tile";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { usePaletteLiveQuery } from "@/lib/commands/palette-query-context";
import { matchesPathQuery } from "@/lib/commands/path-query";
import { useSettingsStore } from "@/stores/settings/settings-store";
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

interface ChangedFileLeavesArgs {
  readonly ctx: CommandContext;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly query: string;
}

function changedFileLeaves(
  args: ChangedFileLeavesArgs,
): ReadonlyArray<CommandItem> {
  const { ctx, hostId, workspacePath, files, query } = args;
  const matched = files.filter((file) => matchesPathQuery(query, file.path));
  const shown = matched.slice(0, OPENER_RESULT_CAP);
  const leaves = shown.map((file) =>
    openerActionLeaf({
      id: `open:diff:${workspacePath}:${file.path}:${file.stage}`,
      // Workspace-relative path (not just the basename) so duplicate filenames
      // are distinguishable; the row dims the directory, emphasizes the name.
      label: file.path,
      keywords: [file.path],
      run: () =>
        openTileIntoTargetGroup({
          tabId: ctx.activeTabId,
          groupId: ctx.targetGroupId,
          ref: makeGitFileDiffTileForFile({
            hostId,
            runningDir: workspacePath,
            file,
          }),
          navigateNestedFocus: ctx.router.navigateNestedFocus,
        }),
    }),
  );
  if (matched.length > shown.length) {
    return [...leaves, openerTruncatedHint("diff", shown.length)];
  }
  return leaves;
}

function useDiffStepItems(
  ctx: CommandContext,
  row: WorktreeBindingSelectorRow | null,
): ReadonlyArray<CommandItem> {
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const runningDir = row === null ? null : row.runningDir;
  const changed = useGitListChangedFilesSubscription({
    hostId: row === null ? "" : row.hostId,
    runningDir,
    ignoreWhitespace,
    enabled: row !== null,
  });
  const query = usePaletteLiveQuery();
  const files = changed.data?.files;
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (row === null || files === undefined) return [];
    return changedFileLeaves({
      ctx,
      hostId: row.hostId,
      workspacePath: row.runningDir,
      files,
      query,
    });
  }, [ctx, row, files, query]);
}

function makeDiffStepSubpage(row: WorktreeBindingSelectorRow): CommandSubpage {
  return {
    id: `open:diff:ws:${row.hostId}:${encodeURIComponent(row.runningDir)}`,
    title: getBasename(row.runningDir),
    useItems: (ctx) => useDiffStepItems(ctx, row),
  };
}

export function useDiffOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: ctx.activeEpicId ?? "",
    enabled: ctx.activeEpicId !== null,
  });
  const gitWorkspaces = useMemo(
    () => bindingsQuery.data?.rows.filter((row) => isGitSelectable(row)) ?? [],
    [bindingsQuery.data?.rows],
  );
  // Single git-workspace epics skip the workspace step. The changed-files
  // subscription is called unconditionally (null/disabled when not single).
  const singleRow = gitWorkspaces.length === 1 ? gitWorkspaces[0] : null;
  const singleStep = useDiffStepItems(ctx, singleRow);
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (singleRow !== null) return singleStep;
    return gitWorkspaces.map((row) =>
      openerSubpageLeaf({
        id: `open:diff:ws:${row.hostId}:${encodeURIComponent(row.runningDir)}`,
        label: getBasename(row.runningDir),
        keywords: [row.runningDir],
        subpage: makeDiffStepSubpage(row),
      }),
    );
  }, [gitWorkspaces, singleRow, singleStep]);
}
