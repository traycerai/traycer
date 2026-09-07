import { v4 as uuidv4 } from "uuid";
import type { GitChangedFile, GitStage } from "@traycer/protocol/host";
import { getBasename } from "@/lib/path/cross-platform-path";
import { TILE_KIND_GIT_DIFF } from "@/stores/epics/canvas/tile-kinds";
import type {
  GitDiffBundleGroup,
  GitDiffRepositoryContext,
  GitDiffTilePayload,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import { createDiffTileViewState } from "@/lib/diff/diff-tile-view-state";
import {
  isImageAssetPath,
  isPdfAssetPath,
  isSvgAssetPath,
} from "@/lib/assets/image-extension-allowlist";

/**
 * Deterministic tile id derived from the host + diff payload - mirrors `workspaceFileTabId`.
 * Two tiles for the same diff resolve to the same id, so canvas dedup is plain id equality (no `sameGitDiffIdentity`).
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

export interface GitImageDiffSides {
  /** Stage to request the OLD (pre-change) side at; `null` = no old side (Added empty state). */
  readonly oldStage: "staged" | "unstaged" | null;
  /** Stage to request the NEW (post-change) side at; `null` = no new side (Deleted empty state). */
  readonly newStage: "staged" | "unstaged" | null;
  readonly conflicted: boolean;
}

/**
 * (side, stage) routing for `git.streamFileAsset` from a `GitChangedFile` - there is no server-side "conflicted" signal, so the client constructs these tuples itself (image-preview tech plan section 1 side-table; decision log decisions #9, #10).
 */
export function gitImageDiffSides(file: GitChangedFile): GitImageDiffSides {
  if (file.stage === "conflicted") {
    return { oldStage: "staged", newStage: "unstaged", conflicted: true };
  }
  if (file.status === "added" || file.status === "untracked") {
    return {
      oldStage: null,
      newStage: file.stage === "staged" ? "staged" : "unstaged",
      conflicted: false,
    };
  }
  if (file.status === "deleted") {
    return {
      oldStage: file.stage === "staged" ? "staged" : "unstaged",
      newStage: null,
      conflicted: false,
    };
  }
  const stage = file.stage === "staged" ? "staged" : "unstaged";
  return { oldStage: stage, newStage: stage, conflicted: false };
}

/**
 * ImageDiff remount key includes `headSha`/`stagedOid`/`worktreeOid`; `(path, stage)` alone would keep old bytes through commit/amend.
 * Null OID in degraded-repo mode falls back to tagged stats JSON so a re-stage still remounts; oid and stats must not alias.
 */
type GitRevisionSideKey =
  | readonly ["oid", string]
  | readonly ["stats", string, string, string];

function gitRevisionSideKey(
  oid: string | null,
  file: GitChangedFile,
): GitRevisionSideKey {
  return oid !== null
    ? ["oid", oid]
    : [
        "stats",
        String(file.insertions),
        String(file.deletions),
        String(file.sizeBytes),
      ];
}

export function gitImageDiffRevisionKey(
  file: GitChangedFile,
  headSha: string,
): string {
  return JSON.stringify([
    headSha,
    gitRevisionSideKey(file.stagedOid, file),
    gitRevisionSideKey(file.worktreeOid, file),
  ]);
}

export interface GitImageDiffRouting {
  readonly routeToImageDiff: boolean;
  readonly isSvg: boolean;
}

/**
 * Extension gate before any diff-text fetch (image-preview decision log, decision #6): a binary image extension, or `.svg` (never `isBinary` to git - decision #5), routes to `ImageDiffView`.
 */
export function gitImageDiffRouting(file: GitChangedFile): GitImageDiffRouting {
  const isImage = isImageAssetPath(file.path);
  const isPreviousImage =
    file.previousPath !== null && isImageAssetPath(file.previousPath);
  const isSvg =
    isSvgAssetPath(file.path) ||
    (file.previousPath !== null && isSvgAssetPath(file.previousPath));
  const isConflicted = file.stage === "conflicted";
  const routeToImageDiff =
    (isImage || isPreviousImage) && (file.isBinary || isSvg || isConflicted);
  return { routeToImageDiff, isSvg };
}

/**
 * Whether the single-file diff tile shows the PDF summary-card view (PDF preview design, Q7 follow-up): per-side "PDF · size · View" cards instead of the plain binary placeholder.
 * Checked AFTER `gitImageDiffRouting` in the tile - a rename straddling both allowlists (`a.png -> b.pdf`) keeps routing to the image diff, whose non-image side already explains itself.
 */
export function gitRoutesToPdfDiffCards(file: GitChangedFile): boolean {
  if (isPdfAssetPath(file.path)) return true;
  // Renamed OFF the allowlist.
  // `old.pdf -> new.bin` keeps the cards, which at least offer the old side where a binary placeholder offers nothing - but `old.pdf -> new.txt` has a real source diff on the surviving side, and a summary card about a file that is no longer a PDF is a worse.
  return (
    file.previousPath !== null &&
    isPdfAssetPath(file.previousPath) &&
    file.isBinary
  );
}

export function gitDiffRepositoryContextLabel(
  context: GitDiffRepositoryContext,
): string {
  if (context.workspaceLabel === context.repositoryLabel) {
    return context.workspaceLabel;
  }
  return `${context.workspaceLabel} › ${context.repositoryLabel}`;
}

export function makeGitFileDiffTile(args: {
  readonly hostId: string;
  readonly runningDir: string;
  readonly filePath: string;
  readonly stage: GitStage;
  readonly repositoryContext: GitDiffRepositoryContext | null;
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
    repositoryContext: args.repositoryContext,
    diff,
    view: createDiffTileViewState(),
  };
}

export function makeGitFileDiffTileForFile(args: {
  readonly hostId: string;
  readonly runningDir: string;
  readonly file: GitChangedFile;
  readonly repositoryContext: GitDiffRepositoryContext | null;
}): GitDiffTileRef {
  return makeGitFileDiffTile({
    hostId: args.hostId,
    runningDir: args.runningDir,
    filePath: args.file.path,
    stage: args.file.stage,
    repositoryContext: args.repositoryContext,
  });
}

export function makeGitBundleDiffTile(args: {
  readonly hostId: string;
  readonly runningDir: string;
  readonly bundleGroup: GitDiffBundleGroup;
  readonly repositoryContext: GitDiffRepositoryContext | null;
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
    name:
      args.repositoryContext === null
        ? `${getBasename(args.runningDir)} · ${gitBundleGroupLabel(args.bundleGroup)}`
        : `${gitDiffRepositoryContextLabel(args.repositoryContext)} · ${gitBundleGroupLabel(args.bundleGroup)}`,
    hostId: args.hostId,
    repositoryContext: args.repositoryContext,
    diff,
    view: createDiffTileViewState(),
  };
}
