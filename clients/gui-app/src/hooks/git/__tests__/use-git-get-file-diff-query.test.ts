import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitGetFileDiffRequest,
  type GitGetFileDiffResponse,
} from "@traycer/protocol/host";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { useGitGetFileDiffQuery } from "../use-git-get-file-diff-query";

// The client is an ARGUMENT now, not an ambient read. The hook used to call
// `useHostClient()` while taking `hostId` separately and asserting in a comment
// that the two were "correlated 1:1" - they were not, which is the D15 defect
// `routesToThePassedClient` below pins. There is deliberately NO `@/lib/host`
// mock left in this file: an app-wide read reintroduced here has nothing to
// answer it.
//
// Real clients over mock messengers rather than chained `as unknown as`
// assertions - the repo's lint forbids those in tests as much as in production,
// and a stub would also hide the day this hook starts calling something it
// lacks.
function buildClient(args: {
  readonly entry: typeof mockLocalHostEntry;
  readonly onFileDiff: (
    request: GitGetFileDiffRequest,
  ) => GitGetFileDiffResponse;
}) {
  let requestCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === args.entry.hostId ? args.entry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () =>
        `req-${args.entry.hostId}-${String((requestCount += 1))}`,
      handlers: { "git.getFileDiff": args.onFileDiff },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(args.entry);
}

const diffResponse = (patch: string): GitGetFileDiffResponse => ({
  filePath: "src/file.ts",
  headSha: "abc123",
  stagedOid: "oid-staged",
  worktreeOid: "oid-worktree",
  patch,
  isTruncated: false,
  truncatedAfterBytes: null,
  isBinary: false,
});

// The TILE's client. Every existing arm passes this one.
let tileRequests: GitGetFileDiffRequest[] = [];
let tileClient: HostClient<HostRpcRegistry>;
// A SECOND client for the host the app is pointed at while the tile stays bound
// to its own. Nothing in this file may reach it.
let appWideRequests: GitGetFileDiffRequest[] = [];
let appWideClient: HostClient<HostRpcRegistry>;

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-1",
    isReady: true,
  }),
}));

describe("useGitGetFileDiffQuery", () => {
  let queryClient: QueryClient;
  let diffPatch = "diff";

  beforeEach(() => {
    vi.clearAllMocks();
    tileRequests = [];
    appWideRequests = [];
    tileClient = buildClient({
      entry: mockLocalHostEntry,
      onFileDiff: (request) => {
        tileRequests.push(request);
        return diffResponse(diffPatch);
      },
    });
    appWideClient = buildClient({
      entry: mockRemoteHostEntry,
      onFileDiff: (request) => {
        appWideRequests.push(request);
        return diffResponse("app-wide host's diff");
      },
    });
    diffPatch = "diff";
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
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          client: tileClient,
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
    expect(tileRequests).toEqual([
      {
        hostId: "host-1",
        runningDir: "/repo",
        filePath: "src/file.ts",
        previousPath: null,
        stage: "unstaged",
        ignoreWhitespace: false,
        byteBudget: DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
      },
    ]);
    const queries = queryClient.getQueryCache().getAll();
    expect(queries).toHaveLength(1);
    expect(queries[0].queryKey).not.toContain(tileClient);
    expect(() => JSON.stringify(queries[0].queryKey)).not.toThrow();
  });

  it("does not request when disabled", async () => {
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          client: tileClient,
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
    expect(tileRequests).toEqual([]);
  });

  it("passes null byteBudget for uncapped full diff requests", async () => {
    diffPatch = "full diff";

    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          client: tileClient,
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

    expect(tileRequests).toEqual([
      {
        hostId: "host-1",
        runningDir: "/repo",
        filePath: "src/file.ts",
        previousPath: null,
        stage: "unstaged",
        ignoreWhitespace: false,
        byteBudget: null,
      },
    ]);
  });

  // The D15 arm. `hostId` names the TILE's host and `client` must be the one
  // that addresses it; the hook used to read `useHostClient()` here, so a tile
  // bound to A kept its A-shaped query key while the request went to whichever
  // host the app was pointed at. Two real clients, and the app-wide one must
  // stay untouched.
  it("routes the request to the PASSED client, never an app-wide one", async () => {
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          client: tileClient,
          hostId: mockLocalHostEntry.hostId,
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
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Non-vacuous in both directions: the tile's messenger answered, and the
    // app-wide client - which is live and would have answered with a different
    // patch - was never asked.
    expect(tileRequests).toHaveLength(1);
    expect(tileClient.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
    expect(appWideRequests).toEqual([]);
    expect(appWideClient.getActiveHostId()).toBe(mockRemoteHostEntry.hostId);
    expect(result.current.data?.patch).toBe("diff");
  });

  it("does not request when hostId is null", async () => {
    const { result } = renderHook(
      () =>
        useGitGetFileDiffQuery({
          client: tileClient,
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
    expect(tileRequests).toEqual([]);
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
