/**
 * Schema for `git-diff` tiles. `parse` recomputes the tile `id` from the
 * host + payload via `gitDiffTileId` rather than trusting the persisted
 * value - older persisted tiles carried a random uuid, so recomputing on
 * rehydrate makes dedup self-healing with no migration step.
 */
import type { GitStage } from "@traycer/protocol/host";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { gitDiffTileId } from "@/lib/git/git-diff-tile";
import { TILE_KIND_GIT_DIFF } from "../tile-kinds";
import type {
  GitDiffBundleGroup,
  GitDiffTilePayload,
  GitDiffTileRef,
} from "../types";
import type { TileSchema } from "./index";
import {
  parseDiffTileViewState,
  serializeDiffTileViewState,
} from "./diff-tile-view";
import { readTileInstanceId } from "./instance-id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGitStage(value: unknown): value is GitStage {
  return (
    value === "staged" ||
    value === "unstaged" ||
    value === "untracked" ||
    value === "conflicted"
  );
}

function isGitDiffBundleGroup(value: unknown): value is GitDiffBundleGroup {
  return value === "merge" || value === "staged" || value === "changes";
}

function parseGitDiffPayload(value: unknown): GitDiffTilePayload | null {
  if (!isRecord(value)) return null;
  if (value.kind === "file") {
    if (
      typeof value.runningDir !== "string" ||
      typeof value.filePath !== "string" ||
      !isGitStage(value.stage)
    ) {
      return null;
    }
    return {
      kind: "file",
      runningDir: value.runningDir,
      filePath: value.filePath,
      stage: value.stage,
    };
  }
  if (value.kind === "bundle") {
    if (
      typeof value.runningDir !== "string" ||
      !isGitDiffBundleGroup(value.bundleGroup)
    ) {
      return null;
    }
    return {
      kind: "bundle",
      runningDir: value.runningDir,
      bundleGroup: value.bundleGroup,
    };
  }
  return null;
}

function parseGitDiffTileRef(value: unknown): GitDiffTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_GIT_DIFF ||
    typeof value.name !== "string" ||
    typeof value.hostId !== "string"
  ) {
    return null;
  }
  const diff = parseGitDiffPayload(value.diff);
  const view = parseDiffTileViewState(value.view);
  if (diff === null || view === null) return null;
  return {
    id: gitDiffTileId(value.hostId, diff),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_GIT_DIFF,
    name: value.name,
    hostId: value.hostId,
    diff,
    view,
  };
}

function serializeGitDiffPayload(
  diff: GitDiffTileRef["diff"],
): DesktopJsonValue {
  switch (diff.kind) {
    case "file":
      return {
        kind: diff.kind,
        runningDir: diff.runningDir,
        filePath: diff.filePath,
        stage: diff.stage,
      };
    case "bundle":
      return {
        kind: diff.kind,
        runningDir: diff.runningDir,
        bundleGroup: diff.bundleGroup,
      };
  }
}

function serializeGitDiffTileRef(ref: GitDiffTileRef): DesktopJsonValue {
  const diff = serializeGitDiffPayload(ref.diff);
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    diff,
    view: serializeDiffTileViewState(ref.view),
  };
}

export const gitDiffTileSchema: TileSchema<GitDiffTileRef> = {
  parse: parseGitDiffTileRef,
  serialize: serializeGitDiffTileRef,
  isRecordBacked: false,
};
