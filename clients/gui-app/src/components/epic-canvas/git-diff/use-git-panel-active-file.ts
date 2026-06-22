import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findActiveGitFileDiffTile } from "@/stores/epics/canvas/actions";
import type { GitDiffBundleGroup } from "@/stores/epics/canvas/types";
import { gitStageBundleGroup } from "@/lib/git/panel-file-rendering";
import {
  selectGitPanelSectionCollapsed,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";

export interface GitPanelActiveFile {
  readonly tileId: string;
  readonly filePath: string;
  readonly group: GitDiffBundleGroup;
}

/**
 * The file the user is "looking at" on the canvas, scoped to the worktree
 * this panel is showing. Returns null when the focused tile belongs to
 * another worktree - the panel never follows across worktrees.
 */
export function useGitPanelActiveFile(args: {
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
}): GitPanelActiveFile | null {
  return useEpicCanvasStore(
    useShallow((s): GitPanelActiveFile | null => {
      const tab = s.tabsById[args.viewTabId];
      if (tab === undefined) return null;
      const canvas = s.canvasByTabId[args.viewTabId];
      if (canvas === undefined) return null;
      const tile = findActiveGitFileDiffTile(canvas);
      if (tile === null || tile.diff.kind !== "file") return null;
      if (tile.hostId !== args.hostId) return null;
      if (tile.diff.runningDir !== args.runningDir) return null;
      return {
        tileId: tile.id,
        filePath: tile.diff.filePath,
        group: gitStageBundleGroup(tile.diff.stage),
      };
    }),
  );
}

/** The active file's path when it belongs to `group`, otherwise null. */
export function gitPanelActiveFilePathForGroup(
  activeFile: GitPanelActiveFile | null,
  group: GitDiffBundleGroup,
): string | null {
  return activeFile !== null && activeFile.group === group
    ? activeFile.filePath
    : null;
}

/**
 * Write-through section reveal: when canvas focus lands on a file whose
 * stage section is collapsed, un-collapse it via the same persisted
 * toggle a manual header click uses. Runs once per focused tile so a
 * deliberate re-collapse afterwards is respected until focus moves again.
 */
export function useGitPanelRevealSection(args: {
  readonly epicId: string;
  readonly activeFile: GitPanelActiveFile | null;
}): void {
  const lastRevealedTileIdRef = useRef<string | null>(null);
  const activeFile = args.activeFile;
  const epicId = args.epicId;

  useEffect(() => {
    if (activeFile === null) {
      lastRevealedTileIdRef.current = null;
      return;
    }
    if (lastRevealedTileIdRef.current === activeFile.tileId) return;
    lastRevealedTileIdRef.current = activeFile.tileId;
    const store = useGitPanelStore.getState();
    if (selectGitPanelSectionCollapsed(epicId, activeFile.group)(store)) {
      store.toggleSection(epicId, activeFile.group);
    }
  }, [activeFile, epicId]);
}
