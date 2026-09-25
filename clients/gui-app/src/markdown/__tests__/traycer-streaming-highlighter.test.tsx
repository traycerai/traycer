import { renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  useThrottledHighlight,
  type StreamingHighlighter,
} from "@tailmark/react";
import * as shikiHighlighter from "@/markdown/shiki-highlighter";
import {
  getOrCreateHighlighter,
  MAX_HIGHLIGHT_CHARS,
} from "@/markdown/shiki-highlighter";
import {
  highlightCacheSizeForTests,
  resetHighlightCacheForTests,
} from "@/markdown/shiki-highlight-cache";
import {
  getTraycerStreamingHighlighter,
  resetTraycerStreamingHighlighterForTests,
} from "@/markdown/traycer-streaming-highlighter";

// The real curated-core highlighter doubles as a smoke test of the
// `shiki/core` + explicit-grammar setup (no full-bundle registry).
beforeAll(async () => {
  await getOrCreateHighlighter();
});

beforeEach(() => {
  resetHighlightCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function highlighter(): StreamingHighlighter {
  return getTraycerStreamingHighlighter();
}

// Wait until the adapter has a ready core + active theme so highlight() works.
async function waitForReady(): Promise<void> {
  const hl = highlighter();
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsub();
      reject(new Error("streaming highlighter readiness timed out"));
    }, 10_000);
    const unsub = hl.subscribe(() => {
      const sample = hl.highlight("const x = 1;", "ts");
      if (sample !== null) {
        window.clearTimeout(timeout);
        unsub();
        resolve();
      }
    });
    // Synchronous path if already ready.
    if (hl.highlight("const x = 1;", "ts") !== null) {
      window.clearTimeout(timeout);
      unsub();
      resolve();
    }
  });
}

describe("curated core highlighter (smoke)", () => {
  it("loads only the active preset's theme pair, and grammars on demand", async () => {
    const core = await getOrCreateHighlighter();
    const themes = core.getLoadedThemes();
    expect(themes).toHaveLength(2);
    expect(themes).toContain("github-dark");
    expect(themes).toContain("github-light");

    // Grammars arrive per fence info (see `shiki-lang-loading.test.ts`); this
    // suite's `waitForReady` highlights `ts`, so typescript is what is here.
    await waitForReady();
    const langs = core.getLoadedLanguages();
    expect(langs).toContain("typescript");
    // Registered aliases resolve for free.
    expect(langs).toContain("ts");
    // Curated grammars nobody has rendered are NOT loaded, and out-of-set ones
    // are never loadable at all.
    expect(langs).not.toContain("make");
    expect(langs).not.toContain("haskell");
  });

  it("falls back to plain for a not-yet-loaded grammar and notifies when it lands", async () => {
    await waitForReady();
    const hl = highlighter();
    const notified = vi.fn();
    const unsubscribe = hl.subscribe(notified);

    // `make` has not been rendered in this process yet, so the first ask is a
    // plain render that also starts the fetch.
    expect(hl.highlight("all:\n\tbun run build\n", "make")).toBeNull();
    // Re-asks during the load (what a streaming block does every frame) stay
    // plain and must not pile up readiness notifications.
    expect(hl.highlight("all:\n\tbun run build\n", "make")).toBeNull();

    await waitFor(() => {
      expect(notified).toHaveBeenCalledTimes(1);
    });
    expect(hl.highlight("all:\n\tbun run build\n", "make")).not.toBeNull();
    unsubscribe();
  });

  it("does not notify for a language outside the curated set", async () => {
    await waitForReady();
    const hl = highlighter();
    const notified = vi.fn();
    const unsubscribe = hl.subscribe(notified);

    expect(hl.highlight("main = putStrLn", "haskell")).toBeNull();
    // Nothing to fetch, so nothing will ever change: a notify here would be a
    // re-render that produces the same plain <pre>.
    await Promise.resolve();
    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("Traycer StreamingHighlighter adapter", () => {
  it("highlights settled blocks and writes the theme-aware cache once", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const hl = highlighter();

    const first = hl.highlight("const a = 1;", "ts");
    expect(first).not.toBeNull();
    if (first === null) return;
    hl.setCached("const a = 1;", "ts", first);
    expect(highlightCacheSizeForTests()).toBe(1);
    const firstCalls = codeToHtml.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // Cache hit - no extra codeToHtml.
    expect(hl.getCached("const a = 1;", "ts")).toBe(first.node);
    expect(codeToHtml.mock.calls.length).toBe(firstCalls);
  });

  it("renders out-of-set languages as plain (null) without caching", async () => {
    await waitForReady();
    const hl = highlighter();
    expect(hl.highlight("main = putStrLn", "haskell")).toBeNull();
    expect(highlightCacheSizeForTests()).toBe(0);
  });

  it("skips highlighting past the char cap", async () => {
    await waitForReady();
    const hl = highlighter();
    expect(hl.highlight("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ts")).toBeNull();
    expect(highlightCacheSizeForTests()).toBe(0);
  });
});

describe("useThrottledHighlight + Traycer adapter", () => {
  it("highlights settled blocks synchronously through the adapter cache", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const hl = highlighter();

    const { result, rerender } = renderHook(
      ({ code }: { code: string }) => useThrottledHighlight(code, "ts", hl),
      { initialProps: { code: "const a = 1;" } },
    );

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    // Effect-time cache write for settled renders.
    await waitFor(() => {
      expect(highlightCacheSizeForTests()).toBe(1);
    });
    const firstCalls = codeToHtml.mock.calls.length;

    rerender({ code: "const a = 1;" });
    expect(result.current).not.toBeNull();
    expect(codeToHtml.mock.calls.length).toBe(firstCalls);
  });
});

describe("TraycerStreamingHighlighter boot retry", () => {
  afterEach(() => {
    resetTraycerStreamingHighlighterForTests();
  });

  it("retries core load after a transient getOrCreateHighlighter failure", async () => {
    resetTraycerStreamingHighlighterForTests();
    const realCore = await getOrCreateHighlighter();
    const getOrCreate = vi
      .spyOn(shikiHighlighter, "getOrCreateHighlighter")
      .mockRejectedValueOnce(new Error("transient load failure"))
      .mockResolvedValue(realCore);
    vi.spyOn(shikiHighlighter, "ensureActiveThemePair").mockResolvedValue(
      undefined,
    );

    const hl = highlighter();
    expect(hl.highlight("const x = 1;", "ts")).toBeNull();
    await waitFor(() => {
      expect(getOrCreate).toHaveBeenCalledTimes(1);
    });
    // Failure cleared the latch; another call must try again.
    expect(hl.highlight("const x = 1;", "ts")).toBeNull();
    await waitFor(() => {
      expect(getOrCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(hl.highlight("const x = 1;", "ts")).not.toBeNull();
    });
  });
});
