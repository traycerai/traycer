import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
  type GitChangedFile,
  type GitGetFileDiffResponse,
  type GitGetFileDiffsResponse,
  type GitStage,
} from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitGetFileDiffsBatched } from "../use-git-get-file-diffs-batched";

interface GitGetFileDiffsRequestLike {
  readonly hostId: string;
  readonly runningDir: string;
  readonly files: ReadonlyArray<{
    readonly filePath: string;
    readonly previousPath: string | null;
    readonly stage: GitStage;
  }>;
  readonly ignoreWhitespace: boolean;
  readonly byteBudget: number;
}

type GitGetFileDiffsRequestMock = (
  method: "git.getFileDiffs",
  params: GitGetFileDiffsRequestLike,
) => Promise<GitGetFileDiffsResponse>;

const mockHostRequest = vi.hoisted(() => vi.fn<GitGetFileDiffsRequestMock>());

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: mockHostRequest,
  }),
}));

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeFile(
  path: string,
  stage: GitStage,
  sizeBytes: number,
): GitChangedFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage,
    isBinary: false,
    insertions: 0,
    deletions: 0,
    sizeBytes,
    stagedOid: null,
    worktreeOid: null,
  };
}

function makeDiff(
  filePath: string,
  stagedOid: string | null,
  worktreeOid: string | null,
): GitGetFileDiffResponse {
  return {
    filePath,
    headSha: "head-1",
    stagedOid,
    worktreeOid,
    patch: `diff --git a/${filePath} b/${filePath}`,
    isTruncated: false,
    truncatedAfterBytes: null,
    isBinary: false,
  };
}

function emptyResponse(): GitGetFileDiffsResponse {
  return {
    runningDir: "/repo",
    headSha: "head-1",
    diffs: [],
  };
}

describe("useGitGetFileDiffsBatched", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
    mockHostRequest.mockReset();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("does not request when disabled or missing a host id", async () => {
    const wrapper = makeWrapper(queryClient);

    renderHook(
      () =>
        useGitGetFileDiffsBatched({
          hostId: "host-1",
          runningDir: "/repo",
          files: [makeFile("a.ts", "unstaged", 1000)],
          visibleRange: { start: 0, end: 1 },
          ignoreWhitespace: false,
          enabled: false,
        }),
      { wrapper },
    );

    renderHook(
      () =>
        useGitGetFileDiffsBatched({
          hostId: null,
          runningDir: "/repo",
          files: [makeFile("a.ts", "unstaged", 1000)],
          visibleRange: { start: 0, end: 1 },
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper },
    );

    await Promise.resolve();

    expect(mockHostRequest).not.toHaveBeenCalled();
  });

  it("requests the visible range with overscan in chunked pages", async () => {
    mockHostRequest.mockResolvedValue(emptyResponse());
    const files = Array.from({ length: 30 }, (_value, index) =>
      makeFile(`file-${index}.ts`, "unstaged", 1000),
    );

    renderHook(
      () =>
        useGitGetFileDiffsBatched({
          hostId: "host-1",
          runningDir: "/repo",
          files,
          visibleRange: { start: 10, end: 20 },
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(mockHostRequest).toHaveBeenCalledTimes(2);
    });

    const requestedFiles = mockHostRequest.mock.calls.flatMap(
      ([_method, params]) => params.files,
    );

    expect(requestedFiles.map((file) => file.filePath)).toEqual(
      Array.from({ length: 20 }, (_value, index) => `file-${index + 8}.ts`),
    );
  });

  it("writes mixed-stage batch responses under their request-stage cache keys", async () => {
    const stagedDiff = makeDiff("staged.ts", "staged-oid", null);
    const unstagedDiff = makeDiff("unstaged.ts", null, "worktree-oid");
    mockHostRequest.mockResolvedValue({
      runningDir: "/repo",
      headSha: "head-1",
      diffs: [stagedDiff, unstagedDiff],
    });

    renderHook(
      () =>
        useGitGetFileDiffsBatched({
          hostId: "host-1",
          runningDir: "/repo",
          files: [
            {
              ...makeFile("staged.ts", "staged", 1000),
              previousPath: "old-staged.ts",
            },
            makeFile("unstaged.ts", "unstaged", 1000),
          ],
          visibleRange: { start: 0, end: 2 },
          ignoreWhitespace: true,
          enabled: true,
        }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(mockHostRequest).toHaveBeenCalledWith("git.getFileDiffs", {
        hostId: "host-1",
        runningDir: "/repo",
        files: [
          {
            filePath: "staged.ts",
            previousPath: "old-staged.ts",
            stage: "staged",
          },
          {
            filePath: "unstaged.ts",
            previousPath: null,
            stage: "unstaged",
          },
        ],
        ignoreWhitespace: true,
        byteBudget: DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
      });
    });

    expect(
      queryClient.getQueryData(
        gitQueryKeys.fileDiff(
          "host-1",
          "/repo",
          "staged.ts",
          "old-staged.ts",
          "staged",
          "head-1",
          "staged-oid",
          null,
          true,
          DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
        ),
      ),
    ).toEqual(stagedDiff);
    expect(
      queryClient.getQueryData(
        gitQueryKeys.fileDiff(
          "host-1",
          "/repo",
          "unstaged.ts",
          null,
          "unstaged",
          "head-1",
          null,
          "worktree-oid",
          true,
          DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
        ),
      ),
    ).toEqual(unstagedDiff);
    expect(
      queryClient.getQueryData(
        gitQueryKeys.fileDiff(
          "host-1",
          "/repo",
          "unstaged.ts",
          null,
          "staged",
          "head-1",
          null,
          "worktree-oid",
          true,
          DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
        ),
      ),
    ).toBeUndefined();
  });
});
