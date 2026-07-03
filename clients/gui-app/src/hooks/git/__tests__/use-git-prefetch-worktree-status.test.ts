import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitPrefetchWorktreeStatus } from "../use-git-prefetch-worktree-status";

const mockClient = {
  request: vi.fn(),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockClient,
}));

describe("useGitPrefetchWorktreeStatus", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  it("fetches listChangedFiles and populates cache", async () => {
    const mockResult = {
      files: [{ path: "a.ts" }, { path: "b.ts" }],
      repoMode: "normal" as const,
    };
    mockClient.request.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    const hostId = "host-1";
    const runningDir = "/path/to/repo";
    const ignoreWhitespace = false;

    await result.current({
      hostId,
      runningDir,
      ignoreWhitespace,
    });

    expect(mockClient.request).toHaveBeenCalledWith("git.listChangedFiles", {
      hostId,
      runningDir,
      ignoreWhitespace,
    });

    // Verify cache is populated using the same key structure
    const key = gitQueryKeys.listChangedFiles(
      hostId,
      runningDir,
      ignoreWhitespace,
    );
    const cached = queryClient.getQueryData(key);
    expect(cached).toEqual(mockResult);
  });

  it("skips fetch if already cached", async () => {
    const hostId = "host-1";
    const runningDir = "/path/to/repo";
    const ignoreWhitespace = false;
    const cachedResult = { files: [], repoMode: "normal" as const };

    const key = gitQueryKeys.listChangedFiles(
      hostId,
      runningDir,
      ignoreWhitespace,
    );
    queryClient.setQueryData(key, cachedResult);

    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    await result.current({
      hostId,
      runningDir,
      ignoreWhitespace,
    });

    // Client should not be called if data is already in cache
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it("handles multiple prefetch calls with different params", async () => {
    const mockResult1 = {
      files: [{ path: "a.ts" }],
      repoMode: "normal" as const,
    };
    const mockResult2 = {
      files: [{ path: "b.ts" }, { path: "c.ts" }],
      repoMode: "normal" as const,
    };
    mockClient.request
      .mockResolvedValueOnce(mockResult1)
      .mockResolvedValueOnce(mockResult2);

    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    await result.current({
      hostId: "host-1",
      runningDir: "/path/a",
      ignoreWhitespace: false,
    });

    await result.current({
      hostId: "host-1",
      runningDir: "/path/b",
      ignoreWhitespace: false,
    });

    expect(mockClient.request).toHaveBeenCalledTimes(2);
  });
});
