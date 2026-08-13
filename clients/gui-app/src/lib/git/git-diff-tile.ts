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
  isSvgAssetPath,
} from "@/lib/assets/image-extension-allowlist";

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

export interface GitImageDiffSides {
  /** Stage to request the OLD (pre-change) side at; `null` = no old side (Added empty state). */
  readonly oldStage: "staged" | "unstaged" | null;
  /** Stage to request the NEW (post-change) side at; `null` = no new side (Deleted empty state). */
  readonly newStage: "staged" | "unstaged" | null;
  readonly conflicted: boolean;
}

/**
 * (side, stage) routing for `git.streamFileAsset` from a `GitChangedFile` -
 * there is no server-side "conflicted" signal, so the client constructs
 * these tuples itself (image-preview tech plan section 1 side-table;
 * decision log decisions #9, #10). Shared between the single-file diff tile
 * and bundle sections, which both need the same routing for the same file.
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
 * `<ImageDiffView>`'s `key` for a git-backed file (PR review P1): its own
 * `useImageAsset` request key covers `(path, stage)`, never `headSha`/
 * `stagedOid` - so a staged or HEAD-relative side that stays mounted through
 * a commit/amend/re-stage keeps showing the OLD bytes, since `(path, stage)`
 * alone is unchanged. The unstaged/worktree side already has its own re-stat
 * (pane-focus nonce, decision #11) so this isn't strictly needed there, but
 * including `worktreeOid` too keeps one key covering every side rather than
 * conditionally narrowing it per file. Forcing a full remount (rather than
 * threading these into the request type) is deliberate: zoom/pan/toolbar
 * state SHOULD reset for a genuinely different image, not just the bytes.
 * Mirrors `git-query-keys.ts`'s `fileDiff` key - the sibling TEXT-diff cache
 * key for the SAME file already includes all three.
 *
 * A null OID is not always "this side doesn't exist" (Codex re-review):
 * ADR-0007's degraded-repo-mode fallback (`assessRepoMode`,
 * `computeStatusPipeline` in `git-service.ts`) skips OID computation
 * entirely under load, nulling `stagedOid`/`worktreeOid` for every changed
 * file in that snapshot regardless of whether the side has real content -
 * indistinguishable, from here, from a genuinely absent side. Falling back
 * to a constant would mean a re-stage/edit that lands while degraded, at an
 * unchanged `headSha`, produces the SAME key and never remounts - and the
 * staged/old side has no other recovery path (unlike the unstaged side's
 * focus-nonce backstop). Falling back to `[insertions, deletions,
 * sizeBytes]` instead - already populated from real diff data even in
 * degraded mode - closes that for any edit that changes line count or byte
 * size (the overwhelming majority); a content swap that preserves all three
 * exactly, during degraded mode, at an unchanged `headSha`, is an accepted
 * residual gap, not chased further.
 *
 * JSON-encoded with an explicit `"oid"`/`"stats"` tag on each side, not
 * delimiter-joined into the OID's own slot: an OID and a stats fallback
 * must never be able to alias each other structurally, not just avoid
 * colliding by string luck (mirrors `requestKeyFor`/`buildImageAssetCacheKey`'s
 * own JSON-array discipline for the identical reason).
 */
type GitRevisionSideKey =
  readonly ["oid", string] | readonly ["stats", string, string, string];

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
 * Extension gate before any diff-text fetch (image-preview decision log,
 * decision #6): a binary image extension, or `.svg` (never `isBinary` to
 * git - decision #5), routes to `ImageDiffView`. A rename's CURRENT path
 * alone is not enough (pre-landing review, P0: `old.png -> new.txt` must
 * still route for its old side) - route when EITHER the current or previous
 * path is allowlisted, and (re-review P1) OR the previous path into the SVG
 * check too (`old.svg -> new.txt` is text to git on the rename). A
 * conflicted file is exempted from the `isBinary` check entirely (live E2E
 * finding, ticket 06): the host's bulk `listChangedFiles` numstat pipeline
 * now resolves a `MERGE_HEAD`/`CHERRY_PICK_HEAD` peer ref for conflicted
 * paths (`resolveConflictedIsBinary`, ticket 08), but falls back to leaving
 * `isBinary: false` unchanged when no such peer ref can be found - decision
 * #10 routes every conflicted image unconditionally regardless, so the
 * extension gate stays the correct signal for that residual gap. Shared
 * between the single-file diff tile (which also drives a per-tile SVG
 * source/image toggle from `isSvg`) and bundle sections (which only need
 * the boolean).
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
