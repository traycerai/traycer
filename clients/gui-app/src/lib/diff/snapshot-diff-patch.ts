import { createTwoFilesPatch } from "diff";

export interface SnapshotUnifiedPatchEntry {
  readonly filePath: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
}

/**
 * Synthesize a unified-diff patch string from a chat file-edit snapshot's
 * before/after content so it can be rendered through the same `@pierre/diffs`
 * pipeline (`parsePatchFiles` -> `<FileDiff>`) the live Git ecosystem uses.
 *
 * The chat snapshot is the agent's captured `beforeContent`/`afterContent` for
 * one edit (or the cumulative first->last for a file). A `null` side means the
 * file did not exist on that side (create -> null before, delete -> null
 * after); we render it as an empty side so the hunk shows a pure add/remove.
 *
 * `filePath` is emitted as the `a/` and `b/` patch headers so the parsed file
 * name carries the repo-relative path (mirrors Git's diff headers).
 */
export function buildSnapshotUnifiedPatch(args: {
  readonly filePath: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly ignoreWhitespace: boolean;
}): string {
  const patch = createTwoFilesPatch(
    `a/${args.filePath}`,
    `b/${args.filePath}`,
    args.beforeContent ?? "",
    args.afterContent ?? "",
    "",
    "",
    { context: 3, ignoreWhitespace: args.ignoreWhitespace },
  );
  return normalizeGitPatchHeader(patch, args.filePath);
}

/** Build one parseable unified-diff string containing multiple snapshot files. */
export function buildSnapshotUnifiedPatchBundle(args: {
  readonly entries: ReadonlyArray<SnapshotUnifiedPatchEntry>;
  readonly ignoreWhitespace: boolean;
}): string {
  return args.entries
    .map((entry) =>
      buildSnapshotUnifiedPatch({
        filePath: entry.filePath,
        beforeContent: entry.beforeContent,
        afterContent: entry.afterContent,
        ignoreWhitespace: args.ignoreWhitespace,
      }).trimEnd(),
    )
    .join("\n");
}

function normalizeGitPatchHeader(patch: string, filePath: string): string {
  const gitHeader = `diff --git a/${filePath} b/${filePath}\n`;
  if (patch.startsWith(gitHeader)) return patch;

  const indexHeaderPattern = /^Index: .*\n=+\n/;
  if (indexHeaderPattern.test(patch)) {
    return patch.replace(indexHeaderPattern, gitHeader);
  }

  const dividerHeaderPattern = /^=+\n/;
  if (dividerHeaderPattern.test(patch)) {
    return patch.replace(dividerHeaderPattern, gitHeader);
  }

  return `${gitHeader}${patch}`;
}
