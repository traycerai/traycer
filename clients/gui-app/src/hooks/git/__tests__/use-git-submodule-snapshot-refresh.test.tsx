import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { __resetRichSlotOrderingForTesting } from "@/lib/git/git-rich-slot-ordering";
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

  function wrapperFor(queryClient: QueryClient) {
    return ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  it("fetches and writes the rich slot even when cached data is fresh", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
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

    await result.current();

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
  });

  it("swallows refresh request failures", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
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

    await expect(result.current()).resolves.toBeUndefined();
  });
});
