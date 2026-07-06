import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitPrefetchWorktreeStatus } from "../use-git-prefetch-worktree-status";

const defaultHostClient = {
  request: vi.fn(),
  label: "default",
};

const hostBClient = {
  request: vi.fn(),
  label: "host-B",
};

const directoryEntries = new Map<string, { hostId: string }>([
  ["host-B", { hostId: "host-B" }],
]);

vi.mock("@/lib/host", () => ({
  useHostClient: () => defaultHostClient,
  useHostDirectory: () => ({
    findById: (hostId: string) => directoryEntries.get(hostId) ?? null,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildTransientHostClient: (
    globalClient: { label: string },
    entry: { hostId: string },
  ) => (entry.hostId === "host-B" ? hostBClient : globalClient),
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
    hostBClient.request.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    const hostId = "host-B";
    const runningDir = "/path/to/repo";
    const ignoreWhitespace = false;

    await result.current({
      hostId,
      runningDir,
      ignoreWhitespace,
    });

    expect(hostBClient.request).toHaveBeenCalledWith("git.listChangedFiles", {
      hostId,
      runningDir,
      ignoreWhitespace,
      includeSubmodules: false,
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

  it("routes the request through the client for args.hostId, not the default host client", async () => {
    const mockResult = { files: [], repoMode: "normal" as const };
    hostBClient.request.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    await result.current({
      hostId: "host-B",
      runningDir: "/path/to/repo",
      ignoreWhitespace: false,
    });

    expect(hostBClient.request).toHaveBeenCalledTimes(1);
    expect(defaultHostClient.request).not.toHaveBeenCalled();
  });

  it("skips the call and writes nothing to cache when args.hostId has no reachable client", async () => {
    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    const hostId = "host-unreachable";
    const runningDir = "/path/to/repo";
    const ignoreWhitespace = false;

    await result.current({
      hostId,
      runningDir,
      ignoreWhitespace,
    });

    expect(hostBClient.request).not.toHaveBeenCalled();
    expect(defaultHostClient.request).not.toHaveBeenCalled();

    const key = gitQueryKeys.listChangedFiles(
      hostId,
      runningDir,
      ignoreWhitespace,
    );
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });

  it("skips fetch if already cached", async () => {
    const hostId = "host-B";
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
    expect(hostBClient.request).not.toHaveBeenCalled();
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
    hostBClient.request
      .mockResolvedValueOnce(mockResult1)
      .mockResolvedValueOnce(mockResult2);

    const { result } = renderHook(() => useGitPrefetchWorktreeStatus(), {
      wrapper,
    });

    await result.current({
      hostId: "host-B",
      runningDir: "/path/a",
      ignoreWhitespace: false,
    });

    await result.current({
      hostId: "host-B",
      runningDir: "/path/b",
      ignoreWhitespace: false,
    });

    expect(hostBClient.request).toHaveBeenCalledTimes(2);
  });
});
