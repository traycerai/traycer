import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitRefreshWorktreeStatus } from "../use-git-refresh-worktree-status";

const mockClient = {
  request: vi.fn(),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockClient,
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
    mockClient.request.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useGitRefreshWorktreeStatus(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        hostId: "host-1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
    });

    expect(mockClient.request).toHaveBeenCalledWith("git.listChangedFiles", {
      hostId: "host-1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    expect(
      queryClient.getQueryData(
        gitQueryKeys.listChangedFiles("host-1", "/repo", false),
      ),
    ).toEqual(response);
  });
});
