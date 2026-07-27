import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  QueryClientProvider,
  QueryObserver,
  type QueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { __resetRichSlotOrderingForTesting } from "@/lib/git/git-rich-slot-ordering";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { useGitSubmoduleSnapshotRefresh } from "../use-git-submodule-snapshot-refresh";

const testState = vi.hoisted(() => ({
  client: {
    request: vi.fn(),
  },
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId === "" ? null : { hostId },
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (entry: { readonly hostId: string } | null) =>
    entry === null ? null : testState.client,
}));

function snapshot(fingerprint: string): GitListChangedFilesResponseV11 {
  return {
    runningDir: "/repo",
    headSha: "head",
    branch: "main",
    files: [],
    fingerprint,
    repoMode: "normal",
    repoState: { kind: "clean" },
    submodules: [],
  };
}

describe("useGitSubmoduleSnapshotRefresh", () => {
  beforeEach(() => {
    __resetRichSlotOrderingForTesting();
    testState.client.request.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function wrapperFor(queryClient: QueryClient) {
    return ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  it("fetches and writes the rich slot even when cached data is fresh", async () => {
    const queryClient = createAppQueryClient();
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "host-1",
      "/repo",
      false,
    );
    queryClient.setQueryData(richKey, snapshot("old"));
    testState.client.request.mockResolvedValue(snapshot("new"));

    const { result } = renderHook(
      () =>
        useGitSubmoduleSnapshotRefresh({
          hostId: "host-1",
          rootRunningDir: "/repo",
          ignoreWhitespace: false,
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    await result.current.refresh();

    expect(testState.client.request).toHaveBeenCalledWith(
      "git.listChangedFiles",
      {
        hostId: "host-1",
        runningDir: "/repo",
        ignoreWhitespace: false,
        includeSubmodules: true,
      },
    );
    expect(
      queryClient.getQueryData<GitListChangedFilesResponseV11>(richKey),
    ).toEqual(snapshot("new"));

    const query = queryClient.getQueryCache().find({
      queryKey: richKey,
      exact: true,
    });
    expect(query?.queryKey).toEqual(richKey);
    expect(query?.options.meta).toMatchObject({
      hostRpcMethod: "git.listChangedFiles",
    });
    expect(query?.options.retry).toBe(false);
    getConditionPollEpisodeCoordinator(queryClient).dispose();
  });

  it("swallows one production-client refresh failure without retrying it", async () => {
    vi.useFakeTimers();
    const queryClient = createAppQueryClient();
    testState.client.request.mockRejectedValue(new Error("host unavailable"));

    const { result } = renderHook(
      () =>
        useGitSubmoduleSnapshotRefresh({
          hostId: "host-1",
          rootRunningDir: "/repo",
          ignoreWhitespace: false,
        }),
      { wrapper: wrapperFor(queryClient) },
    );

    const refresh = result.current.refresh();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(testState.client.request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await expect(refresh).resolves.toBeUndefined();
    expect(testState.client.request).toHaveBeenCalledTimes(1);
    getConditionPollEpisodeCoordinator(queryClient).dispose();
  });

  it("resets a capped dirty rich-slot cadence before its explicit refresh", async () => {
    const queryClient = createAppQueryClient();
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "host-1",
      "/repo",
      false,
    );
    const dirtyResponse = {
      submodules: [
        {
          availability: { state: "unavailable" },
          files: [],
        },
      ],
    };
    const coordinator = getConditionPollEpisodeCoordinator(queryClient);
    const interval = coordinator.refetchIntervalFor("git.listChangedFiles");
    queryClient.setQueryData(richKey, dirtyResponse);
    const observer = new QueryObserver(queryClient, {
      queryKey: richKey,
      queryFn: () => Promise.resolve(dirtyResponse),
      meta: stampHostRpcMethod(undefined, "git.listChangedFiles"),
      retry: false,
      refetchInterval: interval,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    for (let index = 0; index < 4; index += 1) {
      queryClient.setQueryData(richKey, {
        ...dirtyResponse,
        refreshSequence: index,
      });
      const currentQuery = queryClient.getQueryCache().find({
        queryKey: richKey,
        exact: true,
      });
      if (currentQuery === undefined)
        throw new Error("Expected rich-slot query");
      interval(currentQuery);
    }

    const query = queryClient.getQueryCache().find({
      queryKey: richKey,
      exact: true,
    });
    if (query === undefined) throw new Error("Expected rich-slot query");
    expect(interval(query)).toBe(10_000);

    testState.client.request.mockResolvedValue(dirtyResponse);
    const { result } = renderHook(
      () =>
        useGitSubmoduleSnapshotRefresh({
          hostId: "host-1",
          rootRunningDir: "/repo",
          ignoreWhitespace: false,
        }),
      { wrapper: wrapperFor(queryClient) },
    );
    await result.current.refresh();

    expect(interval(query)).toBe(5_000);
    unsubscribe();
    coordinator.dispose();
  });
});
