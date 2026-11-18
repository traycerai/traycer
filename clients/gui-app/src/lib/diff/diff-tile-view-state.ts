import type {
  GitDiffTileViewState,
  PrDiffTileViewState,
} from "@/stores/epics/canvas/types";

export function createDiffTileViewState(): GitDiffTileViewState {
  return {
    collapsedFilePaths: [],
  };
}

export function createPrDiffTileViewState(): PrDiffTileViewState {
  return {
    collapsedFileKeys: [],
  };
}
