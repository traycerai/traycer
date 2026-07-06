import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import {
  getCachedHighlight,
  setCachedHighlight,
} from "./shiki-highlight-cache";
import { highlightCode, MAX_HIGHLIGHT_CHARS } from "./shiki-highlighter";

/**
 * While a code block streams, it re-renders on every coalesced delta flush
 * (~once per frame). Re-tokenizing the whole growing block at that rate is
 * O(N²)-ish main-thread work, so streaming highlights run at most once per
 * this interval (trailing edge - the final state always paints).
 */
export const STREAMING_HIGHLIGHT_THROTTLE_MS = 150;

/**
 * The streaming flag is message-scoped, so a code block can be finished while
 * the message keeps streaming below it. Once a streaming block's code has
 * been stable this long, its current highlight IS the final one - write it to
 * the cache so the settle-flip re-render is a cache hit instead of a burst of
 * synchronous re-highlights across every block in the message.
 *
 * Accepted orphan rate: a provider stall longer than this window writes a
 * not-actually-final intermediate into the cache. That entry is keyed by the
 * intermediate code, so it is never served for the finished block - it just
 * occupies budget until MRU eviction. Stalls past ~2 throttle ticks are rare
 * in practice, and each orphan costs one entry of budget, so we keep the
 * settle write (which makes the eventual `isStreaming` flip a cache hit for
 * blocks that genuinely finished mid-message) rather than gating it on the
 * message-scoped streaming flag.
 */
const STREAMING_SETTLE_CACHE_MS = STREAMING_HIGHLIGHT_THROTTLE_MS * 2;

export interface CodeHighlightInput {
  readonly highlighter: HighlighterCore | null;
  readonly theme: string;
  /** From `useShikiHighlighter`: bumps when a lazy theme pair lands. */
  readonly themesVersion: number;
  readonly code: string;
  readonly language: string;
  readonly isStreaming: boolean;
}

interface ComputedHighlight {
  readonly nodes: ReactNode;
  /**
   * Length of the highlighted HTML for a freshly computed render (the cache
   * budget's accounting unit), or `null` when served from the cache - which
   * also tells effect-time writers there is nothing left to write.
   */
  readonly htmlChars: number | null;
}

// Pure compute: reads the cache (an MRU touch, never a write) and otherwise
// highlights + parses. ALL cache writes happen at effect time in the hook
// below - one purity rule for both the settled and the streaming path.
function computeHighlightNodes(input: {
  readonly highlighter: HighlighterCore | null;
  readonly theme: string;
  readonly code: string;
  readonly language: string;
}): ComputedHighlight | null {
  const { highlighter, theme, code, language } = input;
  if (highlighter === null || language === "") return null;
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const cached = getCachedHighlight(theme, language, code);
  if (cached !== undefined) return { nodes: cached, htmlChars: null };
  const html = highlightCode(highlighter, code, language, theme);
  if (html === null) return null;
  return {
    nodes: trustedMarkupToReactNodes(html, "html"),
    htmlChars: html.length,
  };
}

/**
 * Highlighted React nodes for a code block, or `null` for the plain `<pre>`
 * fallback (no highlighter yet, theme pair still loading, out-of-set
 * language, or content past `MAX_HIGHLIGHT_CHARS`).
 *
 * Settled blocks highlight synchronously through the global MRU cache; the
 * cache write for a fresh settled render happens in an effect (same
 * effect-time rule as the streaming settle write below). Streaming blocks
 * recompute at most every `STREAMING_HIGHLIGHT_THROTTLE_MS` and never write
 * intermediates to the cache (they would churn the whole budget every frame);
 * only a block whose code stops changing for `STREAMING_SETTLE_CACHE_MS`
 * caches its (final) render.
 */
export function useThrottledCodeHighlight(
  input: CodeHighlightInput,
): ReactNode | null {
  const { highlighter, theme, themesVersion, code, language, isStreaming } =
    input;

  const settled = useMemo(() => {
    // Re-runs when a lazily-loaded theme pair lands.
    void themesVersion;
    if (isStreaming) return null;
    return computeHighlightNodes({ highlighter, theme, code, language });
  }, [isStreaming, highlighter, theme, themesVersion, code, language]);

  // Effect-time cache write for fresh settled renders (htmlChars === null
  // means the memo was served from the cache and there is nothing to write).
  useEffect(() => {
    if (isStreaming || settled === null || settled.htmlChars === null) return;
    setCachedHighlight(theme, language, code, {
      node: settled.nodes,
      htmlChars: settled.htmlChars,
    });
  }, [isStreaming, settled, theme, language, code]);

  // Seeded synchronously at mount (same render-time compute + MRU-touch
  // contract as the settled memo above). A code block can MOUNT mid-stream
  // with its final code already present: the quote feature's streaming-tail
  // wrapper is removed when a block freezes, which remounts the block while
  // the message keeps streaming. Starting from `null` there would paint an
  // unhighlighted <pre> for up to a throttle tick - a visible flash on
  // every fence that closes mid-message. The settle cache makes this seed a
  // cache hit for exactly that remount.
  const [streamingNodes, setStreamingNodes] = useState<ReactNode | null>(() =>
    isStreaming
      ? (computeHighlightNodes({ highlighter, theme, code, language })?.nodes ??
        null)
      : null,
  );
  const lastStreamingRunAtRef = useRef(0);

  useEffect(() => {
    // Re-runs when a lazily-loaded theme pair lands (keep `themesVersion` in
    // the dep array - without it a streaming block never recovers from the
    // pre-theme `null` highlight).
    void themesVersion;
    if (!isStreaming) return;
    // Trailing-edge throttle: each growth re-arms the timer, but the delay
    // shrinks with time since the last run, so highlights tick steadily at
    // the throttle interval and the last timer always fires.
    let settleTimer: number | null = null;
    const elapsed = Date.now() - lastStreamingRunAtRef.current;
    const delay = Math.max(0, STREAMING_HIGHLIGHT_THROTTLE_MS - elapsed);
    const timer = window.setTimeout(() => {
      lastStreamingRunAtRef.current = Date.now();
      const computed = computeHighlightNodes({
        highlighter,
        theme,
        code,
        language,
      });
      setStreamingNodes(computed?.nodes ?? null);
      if (computed !== null && computed.htmlChars !== null) {
        const { nodes, htmlChars } = computed;
        // Any further growth re-runs this effect and cancels the write, so
        // only a block that has stopped changing caches its (final) render.
        // See STREAMING_SETTLE_CACHE_MS for the accepted orphan rate when a
        // stalled-but-unfinished block slips through.
        settleTimer = window.setTimeout(() => {
          setCachedHighlight(theme, language, code, {
            node: nodes,
            htmlChars,
          });
        }, STREAMING_SETTLE_CACHE_MS);
      }
    }, delay);
    return () => {
      window.clearTimeout(timer);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [isStreaming, highlighter, theme, themesVersion, code, language]);

  return isStreaming ? streamingNodes : (settled?.nodes ?? null);
}
