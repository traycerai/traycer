import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { writeBatchedDiffResponses } from "../write-batched-diff-responses";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

describe("writeBatchedDiffResponses", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("writes responses to per-file cache slots", () => {
    const hostId = "host-1";
    const runningDir = "/path";
    const stage = "staged" as const;
    const ignoreWhitespace = false;

    const responses: GitGetFileDiffResponse[] = [
      {
        filePath: "/path/file1.ts",
        headSha: "abc123",
        stagedOid: "oid-1",
        worktreeOid: "oid-2",
        patch: "diff1",
        isTruncated: false,
        truncatedAfterBytes: null,
        isBinary: false,
      },
      {
        filePath: "/path/file2.ts",
        headSha: "abc123",
        stagedOid: "oid-3",
        worktreeOid: "oid-4",
        patch: "diff2",
        isTruncated: false,
        truncatedAfterBytes: null,
        isBinary: false,
      },
    ];

    writeBatchedDiffResponses({
      queryClient,
      hostId,
      runningDir,
      requestFiles: responses.map((response) => ({
        filePath: response.filePath,
        previousPath: null,
        stage,
      })),
      ignoreWhitespace,
      diffs: responses,
    });

    // Verify each response was written to the correct key using response-side OIDs
    const key1 = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "/path/file1.ts",
      null,
      stage,
      "abc123",
      "oid-1",
      "oid-2",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    const key2 = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "/path/file2.ts",
      null,
      stage,
      "abc123",
      "oid-3",
      "oid-4",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(queryClient.getQueryData(key1)).toEqual(responses[0]);
    expect(queryClient.getQueryData(key2)).toEqual(responses[1]);
  });

  it("uses response-side OIDs for cache key construction", () => {
    const hostId = "host-1";
    const runningDir = "/path";
    const stage = "staged" as const;
    const ignoreWhitespace = false;

    // Simulate a response with different OIDs than request might have
    const response: GitGetFileDiffResponse = {
      filePath: "/path/file.ts",
      headSha: "abc123",
      stagedOid: "response-oid-1",
      worktreeOid: "response-oid-2",
      patch: "diff",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    writeBatchedDiffResponses({
      queryClient,
      hostId,
      runningDir,
      requestFiles: [
        {
          filePath: response.filePath,
          previousPath: null,
          stage,
        },
      ],
      ignoreWhitespace,
      diffs: [response],
    });

    // Key should be built with response OIDs, not request OIDs
    const correctKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "/path/file.ts",
      null,
      stage,
      "abc123",
      "response-oid-1",
      "response-oid-2",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(queryClient.getQueryData(correctKey)).toEqual(response);
  });

  it("uses request-side path for cache key construction", () => {
    const hostId = "host-1";
    const runningDir = "/path";
    const stage = "staged" as const;
    const ignoreWhitespace = false;
    const response: GitGetFileDiffResponse = {
      filePath: "normalized/file.ts",
      headSha: "abc123",
      stagedOid: "response-oid-1",
      worktreeOid: "response-oid-2",
      patch: "diff",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    writeBatchedDiffResponses({
      queryClient,
      hostId,
      runningDir,
      requestFiles: [
        {
          filePath: "subscriber/file.ts",
          previousPath: null,
          stage,
        },
      ],
      ignoreWhitespace,
      diffs: [response],
    });

    const subscriberKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "subscriber/file.ts",
      null,
      stage,
      "abc123",
      "response-oid-1",
      "response-oid-2",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const normalizedResponseKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "normalized/file.ts",
      null,
      stage,
      "abc123",
      "response-oid-1",
      "response-oid-2",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(queryClient.getQueryData(subscriberKey)).toEqual(response);
    expect(queryClient.getQueryData(normalizedResponseKey)).toBeUndefined();
  });

  it("handles empty diffs array", () => {
    writeBatchedDiffResponses({
      queryClient,
      hostId: "host-1",
      runningDir: "/path",
      requestFiles: [],
      ignoreWhitespace: false,
      diffs: [],
    });

    // Should not error
    expect(true).toBe(true);
  });

  it("handles null OIDs in response", () => {
    const hostId = "host-1";
    const runningDir = "/path";
    const stage = "staged" as const;
    const ignoreWhitespace = false;

    const response: GitGetFileDiffResponse = {
      filePath: "/path/file.ts",
      headSha: "abc123",
      stagedOid: null,
      worktreeOid: null,
      patch: "diff",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    writeBatchedDiffResponses({
      queryClient,
      hostId,
      runningDir,
      requestFiles: [
        {
          filePath: response.filePath,
          previousPath: null,
          stage,
        },
      ],
      ignoreWhitespace,
      diffs: [response],
    });

    const key = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "/path/file.ts",
      null,
      stage,
      "abc123",
      null,
      null,
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(queryClient.getQueryData(key)).toEqual(response);
  });

  it("preserves per-file stages for mixed staged and unstaged batch entries", () => {
    const hostId = "host-1";
    const runningDir = "/repo";
    const ignoreWhitespace = false;
    const filePath = "src/file.ts";
    const responses: GitGetFileDiffResponse[] = [
      {
        filePath,
        headSha: "head-1",
        stagedOid: "staged-oid",
        worktreeOid: null,
        patch: "staged patch",
        isTruncated: false,
        truncatedAfterBytes: null,
        isBinary: false,
      },
      {
        filePath,
        headSha: "head-1",
        stagedOid: null,
        worktreeOid: "worktree-oid",
        patch: "unstaged patch",
        isTruncated: false,
        truncatedAfterBytes: null,
        isBinary: false,
      },
    ];

    writeBatchedDiffResponses({
      queryClient,
      hostId,
      runningDir,
      requestFiles: [
        { filePath, previousPath: null, stage: "staged" },
        {
          filePath,
          previousPath: null,
          stage: "unstaged",
        },
      ],
      ignoreWhitespace,
      diffs: responses,
    });

    const stagedKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      filePath,
      null,
      "staged",
      "head-1",
      "staged-oid",
      null,
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const unstagedKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      filePath,
      null,
      "unstaged",
      "head-1",
      null,
      "worktree-oid",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(
      queryClient.getQueryData<GitGetFileDiffResponse>(stagedKey)?.patch,
    ).toBe("staged patch");
    expect(
      queryClient.getQueryData<GitGetFileDiffResponse>(unstagedKey)?.patch,
    ).toBe("unstaged patch");
  });

  it("uses request-side previousPath for cache key construction", () => {
    const hostId = "host-1";
    const runningDir = "/repo";
    const response: GitGetFileDiffResponse = {
      filePath: "src/new-name.ts",
      headSha: "head-1",
      stagedOid: "staged-oid",
      worktreeOid: null,
      patch: "rename patch",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };

    writeBatchedDiffResponses({
      queryClient,
      hostId,
      runningDir,
      requestFiles: [
        {
          filePath: "src/new-name.ts",
          previousPath: "src/old-name.ts",
          stage: "staged",
        },
      ],
      ignoreWhitespace: false,
      diffs: [response],
    });

    const renameKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "src/new-name.ts",
      "src/old-name.ts",
      "staged",
      "head-1",
      "staged-oid",
      null,
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const missingPreviousPathKey = gitQueryKeys.fileDiff(
      hostId,
      runningDir,
      "src/new-name.ts",
      null,
      "staged",
      "head-1",
      "staged-oid",
      null,
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );

    expect(queryClient.getQueryData(renameKey)).toEqual(response);
    expect(queryClient.getQueryData(missingPreviousPathKey)).toBeUndefined();
  });
});
