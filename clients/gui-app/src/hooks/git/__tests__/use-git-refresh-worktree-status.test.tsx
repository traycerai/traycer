import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitRefreshWorktreeStatus } from "../use-git-refresh-worktree-status";

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

describe("useGitRefreshWorktreeStatus", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  it("force-fetches listChangedFiles and writes the canonical cache slot", async () => {
    const response = {
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [{ path: "src/file.ts" }],
      fingerprint: "fp-1",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
    };
    hostBClient.request.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useGitRefreshWorktreeStatus(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        hostId: "host-B",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
    });

    expect(hostBClient.request).toHaveBeenCalledWith("git.listChangedFiles", {
      hostId: "host-B",
      runningDir: "/repo",
      ignoreWhitespace: false,
      includeSubmodules: false,
    });
    expect(
      queryClient.getQueryData(
        gitQueryKeys.listChangedFiles("host-B", "/repo", false),
      ),
    ).toEqual(response);
  });

  it("routes the request through the client for variables.hostId, not the default host client", async () => {
    const response = {
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp-1",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
    };
    hostBClient.request.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useGitRefreshWorktreeStatus(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        hostId: "host-B",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
    });

    expect(hostBClient.request).toHaveBeenCalledTimes(1);
    expect(defaultHostClient.request).not.toHaveBeenCalled();
  });

  it("rejects and writes nothing to cache when variables.hostId has no reachable client", async () => {
    const { result } = renderHook(() => useGitRefreshWorktreeStatus(), {
      wrapper,
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          hostId: "host-unreachable",
          runningDir: "/repo",
          ignoreWhitespace: false,
        }),
      ).rejects.toThrow();
    });

    expect(hostBClient.request).not.toHaveBeenCalled();
    expect(defaultHostClient.request).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(
        gitQueryKeys.listChangedFiles("host-unreachable", "/repo", false),
      ),
    ).toBeUndefined();
  });
});
