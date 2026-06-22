import { structuredPatch } from "diff";
import type { BundledLanguage, SpecialLanguage } from "shiki";

/**
 * Structured hunks for a file-change diff, used by the cumulative/bundle diff
 * surfaces (which still resolve before/after content host-side) to derive the
 * +N/−M counter. Per-chat-block file_change rows instead carry precomputed
 * `additions`/`deletions` on the segment (see `FileChangeSegment`), so they
 * need no content to render the counter.
 */

export type DiffRowKind = "added" | "removed" | "context";

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** 1-based line number in the pre-edit file. `null` for added rows. */
  readonly oldLineNo: number | null;
  /** 1-based line number in the post-edit file. `null` for removed rows. */
  readonly newLineNo: number | null;
  readonly content: string;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly rows: ReadonlyArray<DiffRow>;
}

function parseDiffHunks(
  beforeContent: string | null,
  afterContent: string | null,
  ignoreWhitespace: boolean,
): ReadonlyArray<DiffHunk> | null {
  if (beforeContent === null && afterContent === null) return null;
  const before = beforeContent ?? "";
  const after = afterContent ?? "";
  if (before === after) return null;
  const patch = structuredPatch("a", "b", before, after, "", "", {
    context: 3,
    ignoreWhitespace,
  });
  if (patch.hunks.length === 0) return null;
  return patch.hunks.map((hunk) => {
    const rows: DiffRow[] = [];
    let oldLineNo = hunk.oldStart;
    let newLineNo = hunk.newStart;
    for (const line of hunk.lines) {
      const marker = line.charAt(0);
      const content = line.slice(1);
      if (marker === "\\") {
        // "\ No newline at end of file" - meta line, doesn't advance counters.
        continue;
      }
      if (marker === "-") {
        rows.push({ kind: "removed", oldLineNo, newLineNo: null, content });
        oldLineNo += 1;
      } else if (marker === "+") {
        rows.push({ kind: "added", oldLineNo: null, newLineNo, content });
        newLineNo += 1;
      } else {
        rows.push({ kind: "context", oldLineNo, newLineNo, content });
        oldLineNo += 1;
        newLineNo += 1;
      }
    }
    return {
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows,
    };
  });
}

export interface DiffLineCounts {
  readonly additions: number;
  readonly deletions: number;
}

function diffLineCountsFromHunks(
  hunks: ReadonlyArray<DiffHunk> | null,
): DiffLineCounts {
  if (hunks === null) return { additions: 0, deletions: 0 };
  return hunks.reduce(
    (counts, hunk) =>
      hunk.rows.reduce(
        (rowCounts, row) => ({
          additions: rowCounts.additions + (row.kind === "added" ? 1 : 0),
          deletions: rowCounts.deletions + (row.kind === "removed" ? 1 : 0),
        }),
        counts,
      ),
    { additions: 0, deletions: 0 },
  );
}

export function diffLineCountsFromContents(
  beforeContent: string | null,
  afterContent: string | null,
  ignoreWhitespace: boolean,
): DiffLineCounts {
  return diffLineCountsFromHunks(
    parseDiffHunks(beforeContent, afterContent, ignoreWhitespace),
  );
}

/** Maps file extensions to shiki language ids from the preloaded set in
 * `shiki-highlighter.ts`. Returns `"text"` for unknowns; shiki has a
 * built-in plain-text alias so this never throws. */
const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  diff: "diff",
  md: "markdown",
  mdx: "markdown",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

export function languageFromFilePath(
  filePath: string,
): BundledLanguage | SpecialLanguage {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "text";
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? "text";
}
