import { v4 as uuidv4 } from "uuid";
import type { GitChangedFile, GitStage } from "@traycer/protocol/host";
import { getBasename } from "@/lib/path/cross-platform-path";
import { TILE_KIND_GIT_DIFF } from "@/stores/epics/canvas/tile-kinds";
import type {
  GitDiffBundleGroup,
  GitDiffTilePayload,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import { createDiffTileViewState } from "@/lib/diff/diff-tile-view-state";

/**
 * Deterministic tile id derived from the host + diff payload - mirrors
 * `workspaceFileTabId`. Two tiles for the same diff resolve to the same
 * id, so canvas dedup is plain id equality (no `sameGitDiffIdentity`).
 */
export function gitDiffTileId(
  hostId: string,
  payload: GitDiffTilePayload,
): string {
  const target = gitDiffTileIdTarget(payload);
  return `${TILE_KIND_GIT_DIFF}:${encodeURIComponent(hostId)}:${target}`;
}

function gitDiffTileIdTarget(payload: GitDiffTilePayload): string {
  switch (payload.kind) {
    case "file":
      return `file:${encodeURIComponent(payload.runningDir)}:${encodeURIComponent(payload.filePath)}:${payload.stage}`;
    case "bundle":
      return `bundle:${encodeURIComponent(payload.runningDir)}:${payload.bundleGroup}`;
  }
}
export function gitStageLabel(stage: GitStage): string {
  if (stage === "staged") return "Staged";
  if (stage === "unstaged") return "Working";
  if (stage === "untracked") return "Untracked";
  return "Conflicted";
}

export function gitBundleGroupLabel(group: GitDiffBundleGroup): string {
  if (group === "merge") return "Merge Changes";
  if (group === "staged") return "Staged";
  return "Changes";
}

export function makeGitFileDiffTile(args: {
  readonly hostId: string;
  readonly runningDir: string;
  readonly filePath: string;
  readonly stage: GitStage;
}): GitDiffTileRef {
  const diff: GitDiffTilePayload = {
    kind: "file",
    runningDir: args.runningDir,
    filePath: args.filePath,
    stage: args.stage,
  };
  return {
    id: gitDiffTileId(args.hostId, diff),
    instanceId: uuidv4(),
    type: TILE_KIND_GIT_DIFF,
    name: `${getBasename(args.filePath)} · ${gitStageLabel(args.stage)}`,
    hostId: args.hostId,
    diff,
    view: createDiffTileViewState(),
  };
}

export function makeGitFileDiffTileForFile(args: {
  readonly hostId: string;
  readonly runningDir: string;
  readonly file: GitChangedFile;
}): GitDiffTileRef {
  return makeGitFileDiffTile({
    hostId: args.hostId,
    runningDir: args.runningDir,
    filePath: args.file.path,
    stage: args.file.stage,
  });
}

export function makeGitBundleDiffTile(args: {
  readonly hostId: string;
  readonly runningDir: string;
  readonly bundleGroup: GitDiffBundleGroup;
}): GitDiffTileRef {
  const diff: GitDiffTilePayload = {
    kind: "bundle",
    runningDir: args.runningDir,
    bundleGroup: args.bundleGroup,
  };
  return {
    id: gitDiffTileId(args.hostId, diff),
    instanceId: uuidv4(),
    type: TILE_KIND_GIT_DIFF,
    name: gitBundleGroupLabel(args.bundleGroup),
    hostId: args.hostId,
    diff,
    view: createDiffTileViewState(),
  };
}
