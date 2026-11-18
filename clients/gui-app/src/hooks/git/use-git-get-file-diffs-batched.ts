import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
  type GitChangedFile,
  type GitGetFileDiffsResponse,
  type HostRpcRegistry,
} from "@traycer/protocol/host";
import { useHostClient } from "@/lib/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { writeBatchedDiffResponses } from "@/lib/git/write-batched-diff-responses";
import { appLogger, describeLogErrorSummary } from "@/lib/logger";

const MAX_FILES_PER_PAGE = 10;

export function useGitGetFileDiffsBatched(args: {
  readonly hostId: string | null;
  readonly runningDir: string;
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly visibleRange: { readonly start: number; readonly end: number };
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): void {
  const queryClient = useQueryClient();
  const client = useHostClient();

  const visibleFiles = useMemo(() => {
    const overscanStart = Math.max(0, args.visibleRange.start - 2);
    const overscanEnd = Math.min(args.files.length, args.visibleRange.end + 8);
    return args.files.slice(overscanStart, overscanEnd);
  }, [args.files, args.visibleRange]);

  useEffect(() => {
    if (!args.enabled || args.hostId === null) {
      return;
    }

    const abortController = new AbortController();

    void fetchPagesForVisibleFiles({
      client,
      queryClient,
      hostId: args.hostId,
      runningDir: args.runningDir,
      files: visibleFiles,
      ignoreWhitespace: args.ignoreWhitespace,
      signal: abortController.signal,
    });

    return () => {
      abortController.abort();
    };
  }, [
    visibleFiles,
    args.enabled,
    args.hostId,
    args.runningDir,
    args.ignoreWhitespace,
    client,
    queryClient,
  ]);
}

async function fetchPagesForVisibleFiles(options: {
  client: HostClient<HostRpcRegistry> | null;
  queryClient: QueryClient;
  hostId: string;
  runningDir: string;
  files: ReadonlyArray<GitChangedFile>;
  ignoreWhitespace: boolean;
  signal: AbortSignal;
}): Promise<void> {
  if (options.client === null) {
    return;
  }

  // Chunk files into pages of at most MAX_FILES_PER_PAGE with byte budget consideration
  const pages: Array<ReadonlyArray<GitChangedFile>> = [];
  let currentPage: GitChangedFile[] = [];
  let currentPageBytes = 0;

  for (const file of options.files) {
    if (options.signal.aborted) {
      return;
    }

    // Check if adding this file would exceed limits
    const fileBytes = file.sizeBytes;
    const wouldExceedCount = currentPage.length >= MAX_FILES_PER_PAGE;
    const wouldExceedBytes =
      currentPageBytes + fileBytes > DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET &&
      currentPage.length > 0;

    if (wouldExceedCount || wouldExceedBytes) {
      pages.push(currentPage);
      currentPage = [];
      currentPageBytes = 0;
    }

    currentPage.push(file);
    currentPageBytes += fileBytes;
  }

  if (currentPage.length > 0) {
    pages.push(currentPage);
  }

  // Fire all pages in parallel
  const pagePromises = pages.map((page) =>
    fetchPage({
      client: options.client,
      queryClient: options.queryClient,
      hostId: options.hostId,
      runningDir: options.runningDir,
      files: page,
      ignoreWhitespace: options.ignoreWhitespace,
      signal: options.signal,
    }),
  );

  await Promise.all(pagePromises);
}

async function fetchPage(options: {
  client: HostClient<HostRpcRegistry> | null;
  queryClient: QueryClient;
  hostId: string;
  runningDir: string;
  files: ReadonlyArray<GitChangedFile>;
  ignoreWhitespace: boolean;
  signal: AbortSignal;
}): Promise<void> {
  if (options.client === null || options.signal.aborted) {
    return;
  }

  try {
    // Batched prefetch covers ordinary working-tree / staged files, all plain
    // stage-based diffs. A submodule's own working-tree files diff the same way,
    // routed by `runningDir` at the submodule repo root.
    const requestFiles = options.files.map((file) => ({
      filePath: file.path,
      previousPath: file.previousPath,
      stage: file.stage,
    }));

    const response: GitGetFileDiffsResponse = await options.client.request(
      "git.getFileDiffs",
      {
        hostId: options.hostId,
        runningDir: options.runningDir,
        files: requestFiles,
        ignoreWhitespace: options.ignoreWhitespace,
        byteBudget: DEFAULT_GIT_FILE_DIFFS_BYTE_BUDGET,
      },
    );

    // The host returns diffs in request order; preserve that pairing so mixed
    // staged/unstaged batches cache each response under its own stage key.
    if (options.files.length > 0) {
      writeBatchedDiffResponses({
        queryClient: options.queryClient,
        hostId: options.hostId,
        runningDir: options.runningDir,
        requestFiles,
        ignoreWhitespace: options.ignoreWhitespace,
        diffs: response.diffs,
      });
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      appLogger.warn("[git] failed to fetch batched file diffs", {
        hostId: options.hostId,
        fileCount: options.files.length,
        ignoreWhitespace: options.ignoreWhitespace,
        aborted: options.signal.aborted,
        error: describeLogErrorSummary(error),
      });
    }
  }
}
