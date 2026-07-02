import {
  buildDiffFindIndexFromPatch,
  buildDiffFindMetadataUnits,
  type DiffFindIndex,
  type DiffFindMetadataUnitInput,
} from "@/lib/diff/diff-find";
import {
  createDiffTileFindSourceFromIndex,
  type DiffTileFindSource,
} from "@/stores/tile-find/diff-tile-find-adapter";

export type BundleDiffFindCoverageState =
  "unloaded" | "collapsed" | "large" | "binary" | "truncated" | "failed";

export interface BundleDiffFindFileInput {
  readonly id: string;
  readonly filePath: string;
  readonly metadataUnits: ReadonlyArray<DiffFindMetadataUnitInput>;
  readonly coverageState: BundleDiffFindCoverageState | null;
}

export interface BundleDiffFindLoadedPatchInput {
  readonly fileId: string;
  readonly patch: string;
  readonly cacheKey: string;
  readonly isTruncated: boolean;
}

export interface BundleDiffFindCoverageCounts {
  readonly unloaded: number;
  readonly collapsed: number;
  readonly large: number;
  readonly binary: number;
  readonly truncated: number;
  readonly failed: number;
}

export interface BundleDiffFindSourceResult {
  readonly source: DiffTileFindSource;
  readonly coverageCounts: BundleDiffFindCoverageCounts;
}

const EMPTY_COUNTS: BundleDiffFindCoverageCounts = {
  unloaded: 0,
  collapsed: 0,
  large: 0,
  binary: 0,
  truncated: 0,
  failed: 0,
};

export function createBundleDiffFindSource(args: {
  readonly files: ReadonlyArray<BundleDiffFindFileInput>;
  readonly loadedPatches: ReadonlyMap<string, BundleDiffFindLoadedPatchInput>;
}): BundleDiffFindSourceResult {
  // Build the index grouped by file in visual (document) order: each file's
  // metadata units followed by its loaded patch units, so find-next walks files
  // top-to-bottom instead of all-metadata-then-all-loaded-patches.
  const index: DiffFindIndex = {
    units: args.files.flatMap((file) => {
      const fileMetadataUnits = buildDiffFindMetadataUnits(file.metadataUnits);
      const loaded = args.loadedPatches.get(file.id);
      if (loaded === undefined) return fileMetadataUnits;
      const patchUnits = buildDiffFindIndexFromPatch({
        patch: loaded.patch,
        metadataUnits: [],
        cacheKey: loaded.cacheKey,
        unitScopeId: loaded.fileId,
      }).units;
      return [...fileMetadataUnits, ...patchUnits];
    }),
  };
  const coverageCounts = bundleCoverageCounts(args);
  const coverageMessage = bundleCoverageMessage(coverageCounts);
  return {
    source: createDiffTileFindSourceFromIndex({
      index,
      isPartial: coverageMessage !== null,
      coverageMessage,
    }),
    coverageCounts,
  };
}

function bundleCoverageCounts(args: {
  readonly files: ReadonlyArray<BundleDiffFindFileInput>;
  readonly loadedPatches: ReadonlyMap<string, BundleDiffFindLoadedPatchInput>;
}): BundleDiffFindCoverageCounts {
  return args.files.reduce<BundleDiffFindCoverageCounts>((counts, file) => {
    const loadedPatch = args.loadedPatches.get(file.id);
    if (loadedPatch !== undefined) {
      if (!loadedPatch.isTruncated) return counts;
      return incrementCoverageCount(counts, "truncated");
    }
    return incrementCoverageCount(counts, file.coverageState ?? "unloaded");
  }, EMPTY_COUNTS);
}

function incrementCoverageCount(
  counts: BundleDiffFindCoverageCounts,
  state: BundleDiffFindCoverageState,
): BundleDiffFindCoverageCounts {
  return {
    ...counts,
    [state]: counts[state] + 1,
  };
}

function bundleCoverageMessage(
  counts: BundleDiffFindCoverageCounts,
): string | null {
  const parts = [
    coveragePart(counts.unloaded, "unloaded"),
    coveragePart(counts.collapsed, "collapsed"),
    coveragePart(counts.large, "large"),
    coveragePart(counts.binary, "binary"),
    coveragePart(counts.truncated, "truncated"),
    coveragePart(counts.failed, "failed"),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return `Partial results: ${formatCoverageParts(parts)} not fully searched.`;
}

function coveragePart(count: number, label: string): string | null {
  if (count === 0) return null;
  return `${count} ${label} ${count === 1 ? "file was" : "files were"}`;
}

function formatCoverageParts(parts: ReadonlyArray<string>): string {
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0] ?? ""} and ${parts[1] ?? ""}`;
  const head = parts.slice(0, -1).join(", ");
  const tail = parts[parts.length - 1] ?? "";
  return `${head}, and ${tail}`;
}
