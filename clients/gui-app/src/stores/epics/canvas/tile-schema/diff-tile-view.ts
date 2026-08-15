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
 * PR-tile codec: reads ONLY `collapsedFileKeys` (tagged canonical keys) and
 * deliberately ignores a legacy `collapsedFilePaths` in the stored record.
 * The two fields hold different value domains that can spell identical
 * strings (a bare path `p:foo` vs the tagged key of `foo`), so migrating or
 * dual-reading the old field would let a legacy entry alias a tagged key;
 * field-level separation is the one construction where it cannot. Old PR
 * tiles hydrate with nothing collapsed, once.
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
