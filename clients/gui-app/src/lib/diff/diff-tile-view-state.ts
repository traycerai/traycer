import type { GitDiffTileViewState } from "@/stores/epics/canvas/types";

export function createDiffTileViewState(): GitDiffTileViewState {
  return {
    collapsedFilePaths: [],
  };
}
