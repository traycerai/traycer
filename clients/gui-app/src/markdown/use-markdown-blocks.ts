import { marked } from "marked";
import { useMemo, useState } from "react";
import { repairMarkdown } from "./markdown-repair";

export interface MarkdownBlock {
  id: number;
  raw: string;
}

export interface MarkdownBlocksResult {
  readonly blocks: MarkdownBlock[];
  /**
   * Top-level token index where the re-lexable open tail begins. Non-space
   * blocks use their token index as `id`, so callers compare `block.id` against
   * this boundary.
   */
  readonly tailStartIndex: number;
}

interface LexedToken {
  type: string;
  raw: string;
}

interface LexCache {
  /** The repaired markdown this cache was produced from. */
  readonly repaired: string;
  /** Every top-level token, in order (space tokens included). */
  readonly tokens: ReadonlyArray<LexedToken>;
  /**
   * Token index where the re-lexable "open tail" begins (see `tailStartIndex`).
   * `0` means there is no stable boundary, so reuse is impossible.
   */
  readonly tailIndex: number;
  /** Byte offset of the blank-line boundary token at `tailIndex - 1`. */
  readonly boundaryOffset: number;
  /** True iff the token raws partition `repaired` exactly (offsets are valid). */
  readonly reconstructs: boolean;
  /**
   * True iff any token is a link-reference `def`. Definitions are global lexer
   * state (a later duplicate is deduped against an earlier one), so a tail-only
   * re-lex can't reproduce the in-context result - reuse is disabled.
   */
  readonly hasDef: boolean;
  readonly blocks: MarkdownBlock[];
}

function lexTokens(repaired: string): LexedToken[] {
  return marked.lexer(repaired).map((token) => ({
    type: token.type,
    raw: token.raw,
  }));
}

function blocksFromTokens(tokens: ReadonlyArray<LexedToken>): MarkdownBlock[] {
  // `id` is the token's position so a block's React key / `MarkdownBlock` memo
  // identity is stable as the message grows - the prefix tokens keep their
  // index, only trailing tokens shift.
  return tokens.flatMap((token, index) =>
    token.type === "space" ? [] : [{ id: index, raw: token.raw }],
  );
}

// Markdown block tokenization is only PARTLY local. Lazy paragraph
// continuation, setext-heading underlines and GFM table-header lookback all
// reach back across a single newline, and a LOOSE list absorbs a blank line
// plus a following item - so appended text CAN reshape an earlier-looking
// boundary. The one boundary none of these can cross is a blank line (a `space`
// token) that does not immediately follow a list. Freezing the prefix only at
// such a boundary is what makes the cached-prefix reuse below sound.
function tailStartIndex(tokens: ReadonlyArray<LexedToken>): number {
  for (let index = tokens.length - 1; index >= 1; index -= 1) {
    if (tokens[index]?.type === "space" && tokens[index - 1]?.type !== "list") {
      return index + 1;
    }
  }
  return 0;
}

function buildCache(tokens: LexedToken[], repaired: string): LexCache {
  // Single pass: confirm the raws are a faithful partition of `repaired` (so the
  // byte offsets we compute are trustworthy) and note any link-reference `def`.
  // `startsWith(raw, offset)` compares in place - no per-frame string building.
  let offset = 0;
  let reconstructs = true;
  let hasDef = false;
  for (const token of tokens) {
    if (token.type === "def") hasDef = true;
    if (!repaired.startsWith(token.raw, offset)) {
      reconstructs = false;
      break;
    }
    offset += token.raw.length;
  }
  const tailIndex = tailStartIndex(tokens);
  let boundaryOffset = 0;
  for (let index = 0; index < tailIndex - 1; index += 1) {
    boundaryOffset += tokens[index]?.raw.length ?? 0;
  }
  return {
    repaired,
    tokens,
    tailIndex,
    boundaryOffset,
    reconstructs,
    hasDef,
    blocks: blocksFromTokens(tokens),
  };
}

interface LexResult {
  readonly blocks: MarkdownBlock[];
  readonly tailStartIndex: number;
  /** Cache to thread into the next call; `null` for blank content. */
  readonly cache: LexCache | null;
}

/**
 * Incrementally lex `content` into top-level markdown blocks, reusing the closed
 * prefix of `prev` when the new content is a verbatim append past a stable
 * blank-line boundary, and re-lexing only the open tail. Pure and React-free so
 * the incremental boundary logic can be unit-tested directly against a full
 * `marked.lexer`.
 *
 * During streaming this runs every animation frame over an ever-growing string;
 * a naive full `marked.lexer` is O(N) per frame (O(N^2) over the message) and
 * allocates a fresh token array each time. The reuse path lexes only the tail
 * and rebuilds no prefix string, so steady-state work is O(open tail).
 */
export function lexMarkdownBlocks(
  prev: LexCache | null,
  content: string,
): LexResult {
  const repaired = repairMarkdown(content);
  if (!repaired.trim()) return { blocks: [], tailStartIndex: 0, cache: null };

  // Reuse requires: the previous lex reconstructed its source (offsets valid),
  // carried no global `def` state, exposed a blank-line boundary, and the new
  // content extends the old verbatim (a pure append - `startsWith` compares in
  // place, no allocation). We then re-lex from the boundary and VALIDATE that
  // the boundary token reproduces identically; if marked's streaming
  // tokenization shifted it, we fall through to a full lex.
  if (
    prev !== null &&
    prev.reconstructs &&
    !prev.hasDef &&
    prev.tailIndex >= 2 &&
    repaired.length > prev.repaired.length &&
    repaired.startsWith(prev.repaired)
  ) {
    const boundaryToken = prev.tokens[prev.tailIndex - 1];
    const relexed = lexTokens(repaired.slice(prev.boundaryOffset));
    if (
      relexed.length > 0 &&
      relexed[0].raw === boundaryToken.raw &&
      relexed[0].type === boundaryToken.type
    ) {
      const tokens = [...prev.tokens.slice(0, prev.tailIndex - 1), ...relexed];
      const cache = buildCache(tokens, repaired);
      return { blocks: cache.blocks, tailStartIndex: cache.tailIndex, cache };
    }
  }

  const cache = buildCache(lexTokens(repaired), repaired);
  return { blocks: cache.blocks, tailStartIndex: cache.tailIndex, cache };
}

// Per-hook-instance lex cache, keyed on a stable identity object the caller
// holds for its lifetime (see the `useState` token below). `lexMarkdownBlocks`
// is idempotent in `content` - re-running with the same string returns the same
// blocks and an equivalent cache - so the write below is safe under React's
// render model (StrictMode double-invocation, discarded renders). The entry is
// dropped automatically when the component unmounts and its key is collected.
const lexCacheByInstance = new WeakMap<object, LexCache>();

/**
 * Splits markdown into top-level blocks for per-block rendering + memoization,
 * incrementally during streaming. See `lexMarkdownBlocks` for the algorithm.
 */
export function useMarkdownBlocks(content: string): MarkdownBlocksResult {
  // Stable identity for this hook instance's cache entry. `useState`'s lazy
  // initializer runs once and the value never changes, so it survives renders
  // without a ref (which the render-purity lint forbids writing here).
  const [cacheKey] = useState(() => ({}));
  return useMemo(() => {
    const prev = lexCacheByInstance.get(cacheKey) ?? null;
    const { blocks, cache, tailStartIndex } = lexMarkdownBlocks(prev, content);
    if (cache === null) {
      lexCacheByInstance.delete(cacheKey);
    } else {
      lexCacheByInstance.set(cacheKey, cache);
    }
    return { blocks, tailStartIndex };
  }, [content, cacheKey]);
}
