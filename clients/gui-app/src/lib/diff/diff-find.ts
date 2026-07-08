import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export type DiffFindUnitKind = "file" | "hunk" | "row";

export type DiffFindUnitSide = "additions" | "deletions" | "context" | "none";

export interface DiffFindMetadataUnitInput {
  readonly id: string;
  readonly text: string;
  readonly filePath: string | null;
  readonly scopeId: string | null;
}

export interface DiffFindUnit {
  readonly id: string;
  readonly kind: DiffFindUnitKind;
  readonly side: DiffFindUnitSide;
  readonly filePath: string | null;
  readonly scopeId: string | null;
  readonly text: string;
  readonly hunkIndex: number | null;
  readonly unifiedLineIndex: number | null;
  readonly splitLineIndex: number | null;
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
}

export interface DiffFindIndex {
  readonly units: ReadonlyArray<DiffFindUnit>;
}

export interface DiffFindMatch {
  readonly id: string;
  readonly unit: DiffFindUnit;
  readonly start: number;
  readonly endExclusive: number;
}

interface MutableLineCursor {
  deletionLineIndex: number;
  additionLineIndex: number;
  deletionLineNumber: number;
  additionLineNumber: number;
  unifiedLineIndex: number;
  splitLineIndex: number;
}

export function buildDiffFindIndexFromPatch(args: {
  readonly patch: string;
  readonly metadataUnits: ReadonlyArray<DiffFindMetadataUnitInput>;
  readonly cacheKey: string;
  readonly unitScopeId: string | null;
}): DiffFindIndex {
  const parsed = parsePatchFiles(args.patch, args.cacheKey);
  const metadataUnits = buildDiffFindMetadataUnits(args.metadataUnits);
  const rowUnits = parsed.flatMap((patchGroup, patchIndex) =>
    patchGroup.files.flatMap((file, fileIndex) =>
      normalizeDiffFileUnits({
        file,
        fileOrdinal: `${patchIndex}:${fileIndex}`,
        scopeId: args.unitScopeId,
      }),
    ),
  );
  return {
    units: [...metadataUnits, ...rowUnits],
  };
}

export function buildDiffFindMetadataUnits(
  units: ReadonlyArray<DiffFindMetadataUnitInput>,
): ReadonlyArray<DiffFindUnit> {
  return units.map((unit): DiffFindUnit => ({
    id: `metadata:${unit.id}`,
    kind: "file",
    side: "none",
    filePath: unit.filePath,
    scopeId: unit.scopeId,
    text: unit.text,
    hunkIndex: null,
    unifiedLineIndex: null,
    splitLineIndex: null,
    oldLineNumber: null,
    newLineNumber: null,
  }));
}

export function findDiffMatches(args: {
  readonly units: ReadonlyArray<DiffFindUnit>;
  readonly query: string;
  readonly matchCase: boolean;
}): ReadonlyArray<DiffFindMatch> {
  if (args.query.length === 0) return [];

  const needle = args.matchCase ? args.query : args.query.toLowerCase();
  return args.units.flatMap((unit) => {
    const haystack = args.matchCase ? unit.text : unit.text.toLowerCase();
    const ranges = findNeedleRanges({
      haystack,
      needle,
      queryLength: args.query.length,
    });
    return ranges.map((range, index): DiffFindMatch => {
      const [start, endExclusive] = range;
      return {
        id: `${unit.id}:${start}:${index}`,
        unit,
        start,
        endExclusive,
      };
    });
  });
}

function normalizeDiffFileUnits(args: {
  readonly file: FileDiffMetadata;
  readonly fileOrdinal: string;
  readonly scopeId: string | null;
}): ReadonlyArray<DiffFindUnit> {
  return args.file.hunks.flatMap((_hunk, hunkIndex) => {
    const hunkUnits = normalizeHunkMetadataUnits({
      file: args.file,
      fileOrdinal: args.fileOrdinal,
      hunkIndex,
      scopeId: args.scopeId,
    });
    const rowUnits = normalizeHunkRowUnits({
      file: args.file,
      fileOrdinal: args.fileOrdinal,
      hunkIndex,
      scopeId: args.scopeId,
    });
    return [...hunkUnits, ...rowUnits];
  });
}

function normalizeHunkMetadataUnits(args: {
  readonly file: FileDiffMetadata;
  readonly fileOrdinal: string;
  readonly hunkIndex: number;
  readonly scopeId: string | null;
}): ReadonlyArray<DiffFindUnit> {
  const hunk = args.file.hunks[args.hunkIndex];
  const text = [hunk.hunkSpecs ?? "", hunk.hunkContext ?? ""]
    .filter((part) => part.length > 0)
    .join(" ");
  if (text.length === 0) return [];

  return [
    {
      id: `hunk:${args.fileOrdinal}:${args.hunkIndex}`,
      kind: "hunk",
      side: "none",
      filePath: args.file.name,
      scopeId: args.scopeId,
      text,
      hunkIndex: args.hunkIndex,
      unifiedLineIndex: hunk.unifiedLineStart,
      splitLineIndex: hunk.splitLineStart,
      oldLineNumber: hunk.deletionStart,
      newLineNumber: hunk.additionStart,
    },
  ];
}

function normalizeHunkRowUnits(args: {
  readonly file: FileDiffMetadata;
  readonly fileOrdinal: string;
  readonly hunkIndex: number;
  readonly scopeId: string | null;
}): ReadonlyArray<DiffFindUnit> {
  const hunk = args.file.hunks[args.hunkIndex];

  const cursor: MutableLineCursor = {
    deletionLineIndex: hunk.deletionLineIndex,
    additionLineIndex: hunk.additionLineIndex,
    deletionLineNumber: hunk.deletionStart,
    additionLineNumber: hunk.additionStart,
    unifiedLineIndex: hunk.unifiedLineStart,
    splitLineIndex: hunk.splitLineStart,
  };

  return hunk.hunkContent.flatMap((content, contentIndex) => {
    if (content.type === "context") {
      return normalizeContextRows({
        file: args.file,
        fileOrdinal: args.fileOrdinal,
        hunkIndex: args.hunkIndex,
        contentIndex,
        count: content.lines,
        cursor,
        scopeId: args.scopeId,
      });
    }
    return normalizeChangeRows({
      file: args.file,
      fileOrdinal: args.fileOrdinal,
      hunkIndex: args.hunkIndex,
      contentIndex,
      deletions: content.deletions,
      additions: content.additions,
      cursor,
      scopeId: args.scopeId,
    });
  });
}

function normalizeContextRows(args: {
  readonly file: FileDiffMetadata;
  readonly fileOrdinal: string;
  readonly hunkIndex: number;
  readonly contentIndex: number;
  readonly count: number;
  readonly cursor: MutableLineCursor;
  readonly scopeId: string | null;
}): ReadonlyArray<DiffFindUnit> {
  const units = Array.from({ length: args.count }, (_value, rowIndex) => {
    const lineIndex = args.cursor.additionLineIndex + rowIndex;
    return {
      id: `row:${args.fileOrdinal}:${args.hunkIndex}:${args.contentIndex}:context:${rowIndex}`,
      kind: "row",
      side: "context",
      filePath: args.file.name,
      scopeId: args.scopeId,
      text: visibleDiffLineText(args.file.additionLines[lineIndex] ?? ""),
      hunkIndex: args.hunkIndex,
      unifiedLineIndex: args.cursor.unifiedLineIndex + rowIndex,
      splitLineIndex: args.cursor.splitLineIndex + rowIndex,
      oldLineNumber: args.cursor.deletionLineNumber + rowIndex,
      newLineNumber: args.cursor.additionLineNumber + rowIndex,
    } satisfies DiffFindUnit;
  });

  args.cursor.deletionLineIndex += args.count;
  args.cursor.additionLineIndex += args.count;
  args.cursor.deletionLineNumber += args.count;
  args.cursor.additionLineNumber += args.count;
  args.cursor.unifiedLineIndex += args.count;
  args.cursor.splitLineIndex += args.count;
  return units;
}

function normalizeChangeRows(args: {
  readonly file: FileDiffMetadata;
  readonly fileOrdinal: string;
  readonly hunkIndex: number;
  readonly contentIndex: number;
  readonly deletions: number;
  readonly additions: number;
  readonly cursor: MutableLineCursor;
  readonly scopeId: string | null;
}): ReadonlyArray<DiffFindUnit> {
  const deletionUnits = Array.from(
    { length: args.deletions },
    (_value, rowIndex) =>
      ({
        id: `row:${args.fileOrdinal}:${args.hunkIndex}:${args.contentIndex}:deletion:${rowIndex}`,
        kind: "row",
        side: "deletions",
        filePath: args.file.name,
        scopeId: args.scopeId,
        text: visibleDiffLineText(
          args.file.deletionLines[args.cursor.deletionLineIndex + rowIndex] ??
            "",
        ),
        hunkIndex: args.hunkIndex,
        unifiedLineIndex: args.cursor.unifiedLineIndex + rowIndex,
        splitLineIndex: args.cursor.splitLineIndex + rowIndex,
        oldLineNumber: args.cursor.deletionLineNumber + rowIndex,
        newLineNumber: null,
      }) satisfies DiffFindUnit,
  );
  const additionUnits = Array.from(
    { length: args.additions },
    (_value, rowIndex) =>
      ({
        id: `row:${args.fileOrdinal}:${args.hunkIndex}:${args.contentIndex}:addition:${rowIndex}`,
        kind: "row",
        side: "additions",
        filePath: args.file.name,
        scopeId: args.scopeId,
        text: visibleDiffLineText(
          args.file.additionLines[args.cursor.additionLineIndex + rowIndex] ??
            "",
        ),
        hunkIndex: args.hunkIndex,
        unifiedLineIndex:
          args.cursor.unifiedLineIndex + args.deletions + rowIndex,
        splitLineIndex: args.cursor.splitLineIndex + rowIndex,
        oldLineNumber: null,
        newLineNumber: args.cursor.additionLineNumber + rowIndex,
      }) satisfies DiffFindUnit,
  );

  args.cursor.deletionLineIndex += args.deletions;
  args.cursor.additionLineIndex += args.additions;
  args.cursor.deletionLineNumber += args.deletions;
  args.cursor.additionLineNumber += args.additions;
  args.cursor.unifiedLineIndex += args.deletions + args.additions;
  args.cursor.splitLineIndex += Math.max(args.deletions, args.additions);
  return [...deletionUnits, ...additionUnits];
}

function findNeedleRanges(args: {
  readonly haystack: string;
  readonly needle: string;
  readonly queryLength: number;
}): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const step = Math.max(args.queryLength, 1);
  let cursor = 0;
  let index = args.haystack.indexOf(args.needle, cursor);
  while (index !== -1) {
    ranges.push([index, index + args.queryLength]);
    cursor = index + step;
    index = args.haystack.indexOf(args.needle, cursor);
  }
  return ranges;
}

function visibleDiffLineText(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}
