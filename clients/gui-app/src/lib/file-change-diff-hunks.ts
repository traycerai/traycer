import { structuredPatch } from "diff";
import type { BundledLanguage, SpecialLanguage } from "shiki";
import { contentFingerprint } from "@/lib/text-hash";

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

/**
 * `+N/-M` for the accumulated-changes panel, memoized on the content itself.
 *
 * The panel recomputes every row whenever the host replaces its accumulated
 * changes - which is every snapshot frame of an active turn - and each row
 * costs a full `structuredPatch` over both revisions of the file. The rows
 * arrive as freshly decoded objects holding freshly decoded strings, so
 * nothing upstream can memoize them by identity, and a chat that has touched
 * dozens of files was re-diffing all of them several times a second.
 *
 * Keyed by content fingerprint rather than by the content: retaining the key
 * would mean holding a second copy of every file the agent has edited, which
 * is the memory this cache exists to avoid paying twice.
 */
const DIFF_COUNT_CACHE_LIMIT = 512;
const diffCountCache = new Map<string, DiffLineCounts>();

/**
 * Fingerprint of one side of a diff. A `null` side - a created or deleted
 * file - gets its own sentinel rather than skipping the cache entirely.
 * Bulk creation is exactly the shape that produces the most rows per frame,
 * so it is the shape that needs the memo most.
 */
function sideFingerprint(content: string | null): string {
  return content === null ? "~" : contentFingerprint(content);
}

export function diffLineCountsFromContents(
  beforeContent: string | null,
  afterContent: string | null,
  ignoreWhitespace: boolean,
): DiffLineCounts {
  const key = `${ignoreWhitespace ? "w" : "-"}\u0000${sideFingerprint(
    beforeContent,
  )}\u0000${sideFingerprint(afterContent)}`;
  const cached = diffCountCache.get(key);
  if (cached !== undefined) {
    // Map iteration order is insertion order; re-inserting marks this entry
    // most-recently-used so the eviction below drops a genuinely cold one.
    diffCountCache.delete(key);
    diffCountCache.set(key, cached);
    return cached;
  }
  const counts = diffLineCountsFromHunks(
    parseDiffHunks(beforeContent, afterContent, ignoreWhitespace),
  );
  diffCountCache.set(key, counts);
  if (diffCountCache.size > DIFF_COUNT_CACHE_LIMIT) {
    const oldest = diffCountCache.keys().next();
    if (!oldest.done) diffCountCache.delete(oldest.value);
  }
  return counts;
}

/** Test seam: the cache is module-global, so suites that assert on hit/miss
 * behavior have to start from a known state. */
export function resetDiffLineCountCacheForTests(): void {
  diffCountCache.clear();
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
