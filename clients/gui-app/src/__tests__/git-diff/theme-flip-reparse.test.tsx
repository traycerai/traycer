import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiffContent } from "@/components/epic-canvas/git-diff/file-diff-content";

type ParsePatchFiles = typeof parsePatchFiles;

interface MockResolvedTheme {
  resolvedTheme: "light" | "dark";
  themePreset: string;
}

// Mock @pierre/diffs module
vi.mock("@pierre/diffs", async () => {
  const actual = await vi.importActual("@pierre/diffs");
  return {
    ...actual,
    parsePatchFiles: vi.fn<ParsePatchFiles>(() => {
      // Return array format expected by file-diff-content
      return [];
    }),
  };
});

// Mock the resolved theme provider
const mockResolvedTheme: MockResolvedTheme = {
  resolvedTheme: "light",
  themePreset: "default",
};
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => mockResolvedTheme,
}));

describe("theme-flip-reparse: theme toggle triggers re-parse with new cache key", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    vi.clearAllMocks();
  });

  it("changing theme triggers parsePatchFiles with different cache key", async () => {
    const mockParse = vi.fn<ParsePatchFiles>(() => []);

    vi.mocked(parsePatchFiles).mockImplementation(mockParse);

    const diff = {
      filePath: "src/main.ts",
      headSha: "abc123",
      stagedOid: "def456",
      worktreeOid: "ghi789",
      patch: "@@ -1,3 +1,4 @@\\n sample patch",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <FileDiffContent
          diff={diff}
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          sizing="fill"
          scrollContainerRef={null}
          onScroll={null}
          onLoadFull={() => {}}
        />
      </QueryClientProvider>,
    );

    // parsePatchFiles should be called once with light theme cache key
    await waitFor(() => {
      expect(mockParse).toHaveBeenCalledTimes(1);
    });
    if (mockParse.mock.calls.length < 1) {
      throw new Error("Expected first call to parsePatchFiles");
    }
    const firstCall = mockParse.mock.calls[0];
    expect(firstCall[0]).toBe(diff.patch);
    const firstCacheKey = firstCall[1];
    if (typeof firstCacheKey !== "string") {
      throw new Error("Expected cache key to be a string");
    }
    expect(firstCacheKey).toContain("light");

    // Simulate theme change to dark
    mockResolvedTheme.resolvedTheme = "dark";

    rerender(
      <QueryClientProvider client={queryClient}>
        <FileDiffContent
          diff={diff}
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          sizing="fill"
          scrollContainerRef={null}
          onScroll={null}
          onLoadFull={() => {}}
        />
      </QueryClientProvider>,
    );

    // parsePatchFiles should be called again with dark theme cache key
    await waitFor(() => {
      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    if (mockParse.mock.calls.length < 2) {
      throw new Error("Expected second call to parsePatchFiles");
    }
    const secondCall = mockParse.mock.calls[1];
    expect(secondCall[0]).toBe(diff.patch);
    const secondCacheKey = secondCall[1];
    if (typeof secondCacheKey !== "string") {
      throw new Error("Expected cache key to be a string");
    }
    expect(secondCacheKey).toContain("dark");

    // Verify cache keys are different
    expect(firstCacheKey).not.toBe(secondCacheKey);
  });

  it("cache key includes file path and OIDs for host-query cache hit", () => {
    const mockParse = vi.fn<ParsePatchFiles>(() => []);

    vi.mocked(parsePatchFiles).mockImplementation(mockParse);

    const diff = {
      filePath: "src/foo.ts",
      headSha: "abc123",
      stagedOid: "oid-staged-1",
      worktreeOid: "oid-worktree-1",
      patch: "@@ -1,3 +1,4 @@\\n sample",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    // The patch field is passed to parseP atchFiles via diff prop
    expect(typeof diff.patch).toBe("string");

    render(
      <QueryClientProvider client={queryClient}>
        <FileDiffContent
          diff={diff}
          mode="split"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          sizing="fill"
          scrollContainerRef={null}
          onScroll={null}
          onLoadFull={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(mockParse).toHaveBeenCalled();
    const callArgs = mockParse.mock.calls[0];
    const cacheKey = callArgs[1];

    // Cache key should include theme, filePath, and OIDs
    expect(cacheKey).toContain("src/foo.ts");
    expect(cacheKey).toContain("oid-staged-1");
    expect(cacheKey).toContain("oid-worktree-1");
  });
});
