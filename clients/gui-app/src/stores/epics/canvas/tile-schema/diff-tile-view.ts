import type { DesktopJsonValue } from "@/lib/windows/types";
import type { GitDiffTileViewState } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function parseDiffTileViewState(
  value: unknown,
): GitDiffTileViewState | null {
  if (!isRecord(value)) return null;
  return {
    collapsedFilePaths: readStringArray(value.collapsedFilePaths),
  };
}

export function serializeDiffTileViewState(
  view: GitDiffTileViewState,
): DesktopJsonValue {
  return {
    collapsedFilePaths: [...view.collapsedFilePaths],
  };
}
