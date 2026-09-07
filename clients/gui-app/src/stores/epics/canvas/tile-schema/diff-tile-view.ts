import type { DesktopJsonValue } from "@/lib/windows/types";
import type { GitDiffTileViewState, PrDiffTileViewState } from "../types";

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

/**
 * PR-tile codec: reads ONLY `collapsedFileKeys` (tagged canonical keys) and deliberately ignores a
 * legacy `collapsedFilePaths` in the stored record.
 */
export function parsePrDiffTileViewState(
  value: unknown,
): PrDiffTileViewState | null {
  if (!isRecord(value)) return null;
  return {
    collapsedFileKeys: readStringArray(value.collapsedFileKeys),
  };
}

export function serializePrDiffTileViewState(
  view: PrDiffTileViewState,
): DesktopJsonValue {
  return {
    collapsedFileKeys: [...view.collapsedFileKeys],
  };
}
