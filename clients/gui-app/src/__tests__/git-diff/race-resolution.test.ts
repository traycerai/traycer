import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET } from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeBatchedDiffResponses } from "@/lib/git/write-batched-diff-responses";
import type { GitGetFileDiffResponse } from "@traycer/protocol/host/git-schemas";

describe("race-resolution: Q20 invalidate-then-write race", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("batched response post-invalidate writes to v2 key, leaves v1 empty", () => {
    // 1. Seed cache with a v1 entry
    const v1Key = gitQueryKeys.fileDiff(
      "host-1",
      "/repo",
      "foo.ts",
      null,
      "unstaged",
      "head1",
      "stagedV1",
      "worktreeV1",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const v1Diff = {
      filePath: "foo.ts",
      headSha: "head1",
      stagedOid: "stagedV1",
      worktreeOid: "worktreeV1",
      patch: "v1-patch",
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    };
    queryClient.setQueryData(v1Key, v1Diff);
    expect(queryClient.getQueryData(v1Key)).toBeDefined();

    // 2. Subscription removes the v1 entry (simulating stale subscription removal)
    // In the real scenario, invalidateQueries followed by async refetch arrival
    // leaves the key empty when new data uses a different key.
    queryClient.removeQueries({ queryKey: v1Key });
    expect(queryClient.getQueryData(v1Key)).toBeUndefined();

    // 3. Batched response arrives with v2 OIDs
    writeBatchedDiffResponses({
      queryClient,
      hostId: "host-1",
      runningDir: "/repo",
      requestFiles: [
        {
          filePath: "foo.ts",
          previousPath: null,
          stage: "unstaged",
        },
      ],
      ignoreWhitespace: false,
      diffs: [
        {
          filePath: "foo.ts",
          headSha: "head1",
          stagedOid: "stagedV2",
          worktreeOid: "worktreeV2",
          patch: "v2-patch",
          isTruncated: false,
          truncatedAfterBytes: null,
          isBinary: false,
        },
      ],
    });

    // 4. Assert v1 still empty, v2 populated
    expect(queryClient.getQueryData(v1Key)).toBeUndefined();
    const v2Key = gitQueryKeys.fileDiff(
      "host-1",
      "/repo",
      "foo.ts",
      null,
      "unstaged",
      "head1",
      "stagedV2",
      "worktreeV2",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const v2Data = queryClient.getQueryData<GitGetFileDiffResponse>(v2Key);
    expect(v2Data).toBeDefined();
    expect(v2Data?.patch).toBe("v2-patch");
  });

  it("multiple files in batched response write correctly", () => {
    const ignoreWhitespace = false;

    // Seed v1 entries for two files
    const v1Key1 = gitQueryKeys.fileDiff(
      "d",
      "/r",
      "file1.ts",
      null,
      "staged",
      "head1",
      "oid1v1",
      "oid2v1",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const v1Key2 = gitQueryKeys.fileDiff(
      "d",
      "/r",
      "file2.ts",
      null,
      "staged",
      "head1",
      "oid3v1",
      "oid4v1",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    queryClient.setQueryData(v1Key1, { filePath: "file1.ts" });
    queryClient.setQueryData(v1Key2, { filePath: "file2.ts" });

    // Remove both (simulating cleanup after stale subscription invalidation)
    queryClient.removeQueries({ queryKey: v1Key1 });
    queryClient.removeQueries({ queryKey: v1Key2 });

    // Write v2 responses for both
    writeBatchedDiffResponses({
      queryClient,
      hostId: "d",
      runningDir: "/r",
      requestFiles: [
        {
          filePath: "file1.ts",
          previousPath: null,
          stage: "staged",
        },
        {
          filePath: "file2.ts",
          previousPath: null,
          stage: "staged",
        },
      ],
      ignoreWhitespace,
      diffs: [
        {
          filePath: "file1.ts",
          headSha: "head1",
          stagedOid: "oid1v2",
          worktreeOid: "oid2v2",
          patch: "p1",
          isTruncated: false,
          truncatedAfterBytes: null,
          isBinary: false,
        },
        {
          filePath: "file2.ts",
          headSha: "head1",
          stagedOid: "oid3v2",
          worktreeOid: "oid4v2",
          patch: "p2",
          isTruncated: false,
          truncatedAfterBytes: null,
          isBinary: false,
        },
      ],
    });

    // Assert v1 keys empty, v2 keys populated
    expect(queryClient.getQueryData(v1Key1)).toBeUndefined();
    expect(queryClient.getQueryData(v1Key2)).toBeUndefined();

    const v2Key1 = gitQueryKeys.fileDiff(
      "d",
      "/r",
      "file1.ts",
      null,
      "staged",
      "head1",
      "oid1v2",
      "oid2v2",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const v2Key2 = gitQueryKeys.fileDiff(
      "d",
      "/r",
      "file2.ts",
      null,
      "staged",
      "head1",
      "oid3v2",
      "oid4v2",
      ignoreWhitespace,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    expect(
      queryClient.getQueryData<GitGetFileDiffResponse>(v2Key1)?.patch,
    ).toBe("p1");
    expect(
      queryClient.getQueryData<GitGetFileDiffResponse>(v2Key2)?.patch,
    ).toBe("p2");
  });
});
