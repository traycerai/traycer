import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitGetFileDiffQuery } from "../use-git-get-file-diff-query";

const circularSchema: { def: { element: object | null } } = {
  def: { element: null },
};
circularSchema.def.element = circularSchema;

const mockHostClient = {
  request: vi.fn(),
  schema: circularSchema,
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-1",
    isReady: true,
  }),
}));

describe("useGitGetFileDiffQuery", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  function makeWrapper() {
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
  }

  it("creates query with OID-bearing key", () => {
    const hostId = "host-1";
    const runningDir = "/path";
    const filePath = "/path/file.ts";
    const stage = "staged" as const;
    const headSha = "abc123";
    const stagedOid = "oid-staged";
    const worktreeOid = "oid-worktree";
    const ignoreWhitespace = false;

    const expectedKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      filePath,
      null,
      stage,
      headSha,
      stagedOid,
      worktreeOid,
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    // Manually verify key structure includes OIDs
    expect(expectedKey).toContain(headSha);
    expect(expectedKey).toContain(stagedOid);
    expect(expectedKey).toContain(worktreeOid);
  });

  it("keeps the circular host client out of the TanStack query key", async () => {
    const response: GitGetFileDiffResponse = {
      filePath: "src/file.ts",
      headSha: "abc123",
      stagedOid: "oid-staged",
      worktreeOid: "oid-worktree",
      patch: "diff",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };
    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          hostId: "host-1",
          runningDir: "/repo",
          filePath: "src/file.ts",
          previousPath: null,
          stage: "unstaged",
          headSha: "abc123",
          stagedOid: "oid-staged",
          worktreeOid: "oid-worktree",
          ignoreWhitespace: false,
          byteBudget: DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockHostClient.request).toHaveBeenCalledWith("git.getFileDiff", {
      hostId: "host-1",
      runningDir: "/repo",
      filePath: "src/file.ts",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      byteBudget: DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    });
    const queries = queryClient.getQueryCache().getAll();
    expect(queries).toHaveLength(1);
    expect(queries[0].queryKey).not.toContain(mockHostClient);
    expect(() => JSON.stringify(queries[0].queryKey)).not.toThrow();
  });

  it("does not request when disabled", async () => {
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          hostId: "host-1",
          runningDir: "/path",
          filePath: "/path/file.ts",
          previousPath: null,
          stage: "staged",
          headSha: "abc123",
          stagedOid: "oid-staged",
          worktreeOid: "oid-worktree",
          ignoreWhitespace: false,
          byteBudget: DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
          enabled: false,
        }),
      { wrapper: makeWrapper() },
    );

    await Promise.resolve();

    expect(result.current.isFetching).toBe(false);
    expect(mockHostClient.request).not.toHaveBeenCalled();
  });

  it("passes null byteBudget for uncapped full diff requests", async () => {
    const response: GitGetFileDiffResponse = {
      filePath: "src/file.ts",
      headSha: "abc123",
      stagedOid: null,
      worktreeOid: "oid-worktree",
      patch: "full diff",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };
    mockHostClient.request.mockResolvedValue(response);

    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          hostId: "host-1",
          runningDir: "/repo",
          filePath: "src/file.ts",
          previousPath: null,
          stage: "unstaged",
          headSha: "abc123",
          stagedOid: null,
          worktreeOid: "oid-worktree",
          ignoreWhitespace: false,
          byteBudget: null,
          enabled: true,
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockHostClient.request).toHaveBeenCalledWith("git.getFileDiff", {
      hostId: "host-1",
      runningDir: "/repo",
      filePath: "src/file.ts",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      byteBudget: null,
    });
  });

  it("does not request when hostId is null", async () => {
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          hostId: null,
          runningDir: "/path",
          filePath: "/path/file.ts",
          previousPath: null,
          stage: "staged",
          headSha: "abc123",
          stagedOid: "oid-staged",
          worktreeOid: "oid-worktree",
          ignoreWhitespace: false,
          byteBudget: DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
          enabled: true,
        }),
      { wrapper: makeWrapper() },
    );

    await Promise.resolve();

    expect(result.current.isFetching).toBe(false);
    expect(mockHostClient.request).not.toHaveBeenCalled();
  });

  it("OID change triggers new query key", () => {
    const key1 = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      null,
      "staged",
      "abc123",
      "oid-1",
      "oid-2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    const key2 = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      null,
      "staged",
      "abc123",
      "oid-1-changed",
      "oid-2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(key1).not.toEqual(key2);
  });

  it("previousPath change triggers new query key", () => {
    const key1 = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      null,
      "staged",
      "abc123",
      "oid-1",
      "oid-2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    const key2 = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      "/path/old-file.ts",
      "staged",
      "abc123",
      "oid-1",
      "oid-2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(key1).not.toEqual(key2);
  });

  it("byteBudget change triggers new query key", () => {
    const cappedKey = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      null,
      "staged",
      "abc123",
      "oid-1",
      "oid-2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    const uncappedKey = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      null,
      "staged",
      "abc123",
      "oid-1",
      "oid-2",
      false,
      null,
    );

    expect(cappedKey).not.toEqual(uncappedKey);
  });

  it("runningDir (repoRoot) separates a submodule diff from the parent's same-path diff", () => {
    const parentKey = gitQueryKeys.fileDiff(
      "host-1",
      "/repo",
      "src/foo.ts",
      null,
      "unstaged",
      "head-sha",
      null,
      "wt-oid",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const submoduleKey = gitQueryKeys.fileDiff(
      "host-1",
      "/repo/traycer",
      "src/foo.ts",
      null,
      "unstaged",
      "head-sha",
      null,
      "wt-oid",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(parentKey).not.toEqual(submoduleKey);
  });

  it("sets and retrieves cached file diff data", () => {
    const key = gitQueryKeys.fileDiff(
      "host-1",
      "/path",
      "/path/file.ts",
      null,
      "staged",
      "abc123",
      "oid-1",
      "oid-2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    // Manually set data to verify cache times
    const response: GitGetFileDiffResponse = {
      filePath: "/path/file.ts",
      headSha: "abc123",
      stagedOid: "oid-1",
      worktreeOid: "oid-2",
      patch: "diff",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    queryClient.setQueryData(key, response);
    const query = queryClient.getQueryData(key);

    expect(query).toEqual(response);
  });
});
