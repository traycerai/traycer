import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
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
import * as themeApplier from "@/lib/theme-applier";
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
import { TraycerMarkdown } from "@/markdown/traycer-markdown";

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
  it("loads only the active preset's theme pair and the curated grammars", async () => {
    const core = await getOrCreateHighlighter();
    const themes = core.getLoadedThemes();
    expect(themes).toHaveLength(2);
    expect(themes).toContain("github-dark");
    expect(themes).toContain("github-light");

    const langs = core.getLoadedLanguages();
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

function sourceLine(index: number): string {
  return `export function handler${index}(value: string): number { return ${index}; }`;
}

function fenced(lineCount: number, closed: boolean): string {
  const body = Array.from({ length: lineCount }, (_, index) =>
    sourceLine(index + 1),
  ).join("\n");
  if (!closed) return `Before the file.\n\n\`\`\`ts\n${body}\n`;
  return `Before the file.\n\n\`\`\`ts\n${body}\n\`\`\`\n\nAfter the file.\n`;
}

function markdownView(content: string, isStreaming: boolean) {
  return (
    <TraycerMarkdown
      className={null}
      proseSize="normal"
      components={null}
      remarkPlugins={null}
      rehypePlugins={null}
      quotable={false}
      isStreaming={isStreaming}
    >
      {content}
    </TraycerMarkdown>
  );
}

describe("fenced code while a message is streaming", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not call codeToHtml while an open fence grows, then once when a following block settles it", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");

    const { rerender } = render(markdownView(fenced(2, false), true));
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(document.querySelector(".traycer-md-shiki")).toBeNull();

    rerender(markdownView(fenced(8, false), true));
    rerender(markdownView(fenced(8, false), true));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(highlightCacheSizeForTests()).toBe(0);

    rerender(markdownView(fenced(8, true), true));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    const highlighted = String(codeToHtml.mock.calls[0]?.[0]);
    expect(highlighted).toContain("handler1");
    expect(highlighted).toContain("handler8");
    expect(highlightCacheSizeForTests()).toBe(1);

    const settled = `${fenced(8, true)}More after the file.\n`;
    rerender(markdownView(settled, true));
    expect(codeToHtml).toHaveBeenCalledTimes(1);
    expect(highlightCacheSizeForTests()).toBe(1);

    // Finishing the turn re-renders the fence. The highlight is already cached.
    rerender(markdownView(settled, false));
    expect(codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("highlights an open tail once when the message finishes", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const content = fenced(6, false);

    const { rerender } = render(markdownView(content, true));
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(document.querySelector("[data-md-streaming]")).not.toBeNull();

    rerender(markdownView(content, false));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    expect(String(codeToHtml.mock.calls[0]?.[0])).toContain("handler6");

    rerender(markdownView(content, false));
    expect(codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("keeps a closed fence plain while that fence is still the streaming tail", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const content = "```ts\nconst only = 1;\n```\n";

    const { rerender } = render(markdownView(content, true));
    const block = document.querySelector("[data-quote-code-block]");
    expect(block?.closest("[data-md-streaming]")).not.toBeNull();
    expect(codeToHtml).not.toHaveBeenCalled();

    rerender(markdownView(content, false));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    expect(String(codeToHtml.mock.calls[0]?.[0])).toContain("const only = 1;");
    expect(codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("highlights a settled earlier fence once and leaves the open fence plain", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const open = [
      "```ts",
      "export const firstFence = 1;",
      "```",
      "",
      "```ts",
      sourceLine(1),
      "",
    ].join("\n");

    const { rerender } = render(markdownView(open, true));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    expect(String(codeToHtml.mock.calls[0]?.[0])).toContain("firstFence");
    expect(String(codeToHtml.mock.calls[0]?.[0])).not.toContain("handler1");

    const grown = [
      "```ts",
      "export const firstFence = 1;",
      "```",
      "",
      "```ts",
      sourceLine(1),
      sourceLine(2),
      sourceLine(3),
      "",
    ].join("\n");
    rerender(markdownView(grown, true));
    expect(codeToHtml).toHaveBeenCalledTimes(1);

    const closed = `${grown}\`\`\`\n\nDone.\n`;
    rerender(markdownView(closed, true));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(2);
    });
    expect(String(codeToHtml.mock.calls[1]?.[0])).toContain("handler3");
    expect(String(codeToHtml.mock.calls[1]?.[0])).not.toContain("firstFence");
  });

  it("does not highlight a fence that gains a language while it is still open", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");

    const { rerender } = render(markdownView("```\nconst a = 1;\n", true));
    expect(codeToHtml).not.toHaveBeenCalled();

    rerender(markdownView("```ts\nconst a = 1;\nconst b = 2;\n", true));
    expect(codeToHtml).not.toHaveBeenCalled();

    rerender(
      markdownView("```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.\n", true),
    );
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    const highlighted = String(codeToHtml.mock.calls[0]?.[0]);
    expect(highlighted).toContain("const b = 2;");
    expect(codeToHtml.mock.calls[0]?.[1]).toMatchObject({ lang: "ts" });
  });

  it("highlights a finished fence once and reuses the cache for the next mount", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const content = fenced(3, true);

    const first = render(markdownView(content, false));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    expect(highlightCacheSizeForTests()).toBe(1);
    first.unmount();

    render(markdownView(content, false));
    expect(codeToHtml).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".traycer-md-shiki")).not.toBeNull();
  });

  it("does not highlight inline code or a fence with no language", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");

    render(
      markdownView("Use `inline` here.\n\n```\nplain fence\n```\n", false),
    );
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(
      document
        .querySelector("[data-quote-code-block]")
        ?.getAttribute("data-language"),
    ).toBe("");
    expect(document.querySelector(".traycer-md-shiki")).toBeNull();
  });

  it("does not highlight a prefix when an open fence shrinks, then highlights the shorter fence once", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");

    const { rerender } = render(markdownView(fenced(8, false), true));
    rerender(markdownView(fenced(2, false), true));
    expect(codeToHtml).not.toHaveBeenCalled();

    rerender(markdownView(fenced(2, true), true));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });
    const highlighted = String(codeToHtml.mock.calls[0]?.[0]);
    expect(highlighted).toContain("handler2");
    expect(highlighted).not.toContain("handler8");
  });

  it("highlights a finished fence again when its source changes", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");

    const { rerender } = render(markdownView(fenced(2, true), false));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(1);
    });

    rerender(markdownView(fenced(3, true), false));
    await waitFor(() => {
      expect(codeToHtml).toHaveBeenCalledTimes(2);
    });
    expect(String(codeToHtml.mock.calls[1]?.[0])).toContain("handler3");
    expect(String(codeToHtml.mock.calls[0]?.[0])).not.toContain("handler3");
  });

  it("leaves a settled fence past the character cap as plain text", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const body = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);

    render(markdownView(`\`\`\`ts\n${body}\n\`\`\`\n`, false));
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(document.querySelector(".traycer-md-shiki")).toBeNull();
    expect(document.querySelector("pre")).not.toBeNull();
  });

  it("highlights a settled fence again when the theme changes", async () => {
    await waitForReady();
    const core = await getOrCreateHighlighter();
    const codeToHtml = vi.spyOn(core, "codeToHtml");
    const listeners: Array<() => void> = [];
    vi.spyOn(themeApplier, "subscribeResolvedTheme").mockImplementation(
      (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    );
    resetTraycerStreamingHighlighterForTests();
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");

    try {
      const content = fenced(2, true);
      render(markdownView(content, false));
      await waitFor(() => {
        expect(codeToHtml).toHaveBeenCalledTimes(1);
      });

      root.classList.toggle("dark");
      for (const listener of listeners) listener();

      await waitFor(() => {
        expect(codeToHtml).toHaveBeenCalledTimes(2);
      });
      expect(codeToHtml.mock.calls[1]?.[0]).toBe(codeToHtml.mock.calls[0]?.[0]);
      expect(codeToHtml.mock.calls[1]?.[1]).not.toEqual(
        codeToHtml.mock.calls[0]?.[1],
      );
    } finally {
      root.classList.toggle("dark", wasDark);
      vi.restoreAllMocks();
      resetTraycerStreamingHighlighterForTests();
      await waitForReady();
    }
  });
});
