/**
 * Schema for `git-diff` tiles. `parse` recomputes the tile `id` from the
 * host + payload via `gitDiffTileId` rather than trusting the persisted
 * value - older persisted tiles carried a random uuid, so recomputing on
 * rehydrate makes dedup self-healing with no migration step.
 */
import type { GitStage } from "@traycer/protocol/host";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { gitBundleGroupLabel, gitDiffTileId } from "@/lib/git/git-diff-tile";
import { getBasename } from "@/lib/path/cross-platform-path";
import { TILE_KIND_GIT_DIFF } from "../tile-kinds";
import type {
  GitDiffBundleGroup,
  GitDiffRepositoryContext,
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

function parseGitDiffRepositoryContext(
  value: unknown,
): GitDiffRepositoryContext | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.workspaceLabel !== "string" ||
    typeof value.repositoryLabel !== "string"
  ) {
    return null;
  }
  return {
    workspaceLabel: value.workspaceLabel,
    repositoryLabel: value.repositoryLabel,
  };
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
  const repositoryContext = parseGitDiffRepositoryContext(
    value.repositoryContext,
  );
  const name =
    diff.kind === "bundle" && repositoryContext === null
      ? `${getBasename(diff.runningDir)} · ${gitBundleGroupLabel(diff.bundleGroup)}`
      : value.name;
  return {
    id: gitDiffTileId(value.hostId, diff),
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_GIT_DIFF,
    name,
    hostId: value.hostId,
    repositoryContext,
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
    repositoryContext:
      ref.repositoryContext === null
        ? null
        : {
            workspaceLabel: ref.repositoryContext.workspaceLabel,
            repositoryLabel: ref.repositoryContext.repositoryLabel,
          },
    diff,
    view: serializeDiffTileViewState(ref.view),
  };
}

export const gitDiffTileSchema: TileSchema<GitDiffTileRef> = {
  parse: parseGitDiffTileRef,
  serialize: serializeGitDiffTileRef,
  isRecordBacked: false,
};
