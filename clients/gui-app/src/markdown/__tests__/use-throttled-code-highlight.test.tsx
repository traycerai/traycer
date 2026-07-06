import { renderHook } from "@testing-library/react";
import { act } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { HighlighterCore } from "shiki/core";
import {
  getOrCreateHighlighter,
  MAX_HIGHLIGHT_CHARS,
} from "@/markdown/shiki-highlighter";
import {
  highlightCacheSizeForTests,
  resetHighlightCacheForTests,
} from "@/markdown/shiki-highlight-cache";
import {
  STREAMING_HIGHLIGHT_THROTTLE_MS,
  useThrottledCodeHighlight,
} from "@/markdown/use-throttled-code-highlight";

// The real curated-core highlighter doubles as a smoke test of the
// `shiki/core` + explicit-grammar setup (no full-bundle registry).
let highlighter: HighlighterCore;

beforeAll(async () => {
  highlighter = await getOrCreateHighlighter();
});

beforeEach(() => {
  resetHighlightCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface HookInput {
  readonly code: string;
  readonly language: string;
  readonly isStreaming: boolean;
}

function renderHighlight(initial: HookInput) {
  return renderHook(
    (input: HookInput) =>
      useThrottledCodeHighlight({
        highlighter,
        theme: "github-dark",
        themesVersion: 0,
        code: input.code,
        language: input.language,
        isStreaming: input.isStreaming,
      }),
    { initialProps: initial },
  );
}

describe("curated core highlighter (smoke)", () => {
  it("loads only the active preset's theme pair and the curated grammars", () => {
    const themes = highlighter.getLoadedThemes();
    expect(themes).toHaveLength(2);
    expect(themes).toContain("github-dark");
    expect(themes).toContain("github-light");

    const langs = highlighter.getLoadedLanguages();
    expect(langs).toContain("typescript");
    expect(langs).toContain("make");
    // Registered aliases resolve for free.
    expect(langs).toContain("ts");
    expect(langs).toContain("sh");
    expect(langs).toContain("c#");
    expect(langs).toContain("yml");
    // Out-of-set grammars are NOT registered.
    expect(langs).not.toContain("haskell");
  });
});

describe("useThrottledCodeHighlight", () => {
  it("highlights settled blocks synchronously and writes the cache once", () => {
    const codeToHtml = vi.spyOn(highlighter, "codeToHtml");
    const { result, rerender } = renderHighlight({
      code: "const a = 1;",
      language: "ts",
      isStreaming: false,
    });

    expect(result.current).not.toBeNull();
    expect(highlightCacheSizeForTests()).toBe(1);
    const firstCalls = codeToHtml.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // A second consumer of the same block is a pure cache hit.
    rerender({ code: "const a = 1;", language: "ts", isStreaming: false });
    const second = renderHighlight({
      code: "const a = 1;",
      language: "ts",
      isStreaming: false,
    });
    expect(second.result.current).toBe(result.current);
    expect(codeToHtml.mock.calls.length).toBe(firstCalls);
  });

  it("renders out-of-set languages as plain (null) without caching", () => {
    const { result } = renderHighlight({
      code: "main = putStrLn",
      language: "haskell",
      isStreaming: false,
    });
    expect(result.current).toBeNull();
    expect(highlightCacheSizeForTests()).toBe(0);
  });

  it("skips highlighting past the char cap", () => {
    const { result } = renderHighlight({
      code: "x".repeat(MAX_HIGHLIGHT_CHARS + 1),
      language: "ts",
      isStreaming: false,
    });
    expect(result.current).toBeNull();
    expect(highlightCacheSizeForTests()).toBe(0);
  });

  it("seeds a mid-stream mount synchronously, then throttles growth to the trailing edge without cache writes", () => {
    vi.useFakeTimers();
    const codeToHtml = vi.spyOn(highlighter, "codeToHtml");
    const { result, rerender } = renderHighlight({
      code: "const a =",
      language: "ts",
      isStreaming: true,
    });

    // Mounting mid-stream highlights synchronously: a block can mount with
    // its code already final (the streaming-tail wrapper remount when a block
    // freezes), and starting from null would flash an unhighlighted <pre> for
    // up to a throttle tick. The seed never writes the cache.
    expect(result.current).not.toBeNull();
    expect(codeToHtml).toHaveBeenCalledTimes(1);
    expect(highlightCacheSizeForTests()).toBe(0);

    // Growth faster than the throttle: exactly one more compute, on the
    // trailing timer, not one per rerender.
    rerender({ code: "const a = 1", language: "ts", isStreaming: true });
    rerender({ code: "const a = 1;", language: "ts", isStreaming: true });
    expect(codeToHtml).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(STREAMING_HIGHLIGHT_THROTTLE_MS);
    });
    expect(result.current).not.toBeNull();
    expect(codeToHtml).toHaveBeenCalledTimes(2);
    expect(highlightCacheSizeForTests()).toBe(0);
  });

  it("caches a streaming block once its code stops changing, making the settle flip a hit", () => {
    vi.useFakeTimers();
    const codeToHtml = vi.spyOn(highlighter, "codeToHtml");
    const { result, rerender } = renderHighlight({
      code: "const done = true;",
      language: "ts",
      isStreaming: true,
    });

    act(() => {
      vi.advanceTimersByTime(STREAMING_HIGHLIGHT_THROTTLE_MS);
    });
    const streamed = result.current;
    expect(streamed).not.toBeNull();
    expect(highlightCacheSizeForTests()).toBe(0);

    // Stable code: the settle timer writes the final render to the cache.
    act(() => {
      vi.advanceTimersByTime(STREAMING_HIGHLIGHT_THROTTLE_MS * 2);
    });
    expect(highlightCacheSizeForTests()).toBe(1);

    // The message settles: the settled path is a cache hit, not a re-run.
    const callsBeforeSettle = codeToHtml.mock.calls.length;
    rerender({
      code: "const done = true;",
      language: "ts",
      isStreaming: false,
    });
    expect(result.current).toBe(streamed);
    expect(codeToHtml.mock.calls.length).toBe(callsBeforeSettle);
  });
});
