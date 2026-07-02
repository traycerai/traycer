import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { __resetSubmoduleSnapshotEpochsForTesting } from "@/lib/git/submodule-snapshot-refresh-coordinator";
import { useGitRefreshSubmoduleStatus } from "../use-git-refresh-submodule-status";
import { useGitListChangedFilesWithSubmodules } from "../use-git-list-changed-files-with-submodules";

type SnapshotRequest = (
  method: string,
  params: { readonly refreshRelations: boolean },
) => Promise<unknown>;

const requestByHost = new Map<string, Mock<SnapshotRequest>>();
function clientForHost(hostId: string) {
  let entry = requestByHost.get(hostId);
  if (entry === undefined) {
    entry = vi.fn<SnapshotRequest>();
    requestByHost.set(hostId, entry);
  }
  return { request: entry };
}

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId === "" ? null : { hostId },
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (entry: { hostId: string } | null) =>
    entry === null ? null : clientForHost(entry.hostId),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: unknown) => ({
    hostId: "any",
    requestContextUserId: null,
    isReady: client !== null,
  }),
}));

function snapshot(fingerprint: string, submoduleCount: number) {
  return {
    runningDir: "/repo",
    headSha: "abc123",
    branch: "main",
    files: [{ path: "src/file.ts", gitlink: null }],
    fingerprint,
    repoMode: "normal" as const,
    repoState: { kind: "clean" as const },
    submodules: Array.from({ length: submoduleCount }, (_v, i) => ({
      repoRoot: `/repo/sub${i}`,
      parentPath: `sub${i}`,
      branch: null,
      repoState: { kind: "clean" as const },
      relation: {
        state: "equal" as const,
        recordedPinSha: "1",
        submoduleHeadSha: "1",
      },
      files: [],
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useGitRefreshSubmoduleStatus", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    requestByHost.clear();
    __resetSubmoduleSnapshotEpochsForTesting();
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  it("routes through the selected host with refreshRelations:true and writes both slots", async () => {
    const response = snapshot("fp-forced", 0);
    clientForHost("selected-host").request.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useGitRefreshSubmoduleStatus("selected-host"),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({
        hostId: "selected-host",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
    });

    expect(clientForHost("selected-host").request).toHaveBeenCalledWith(
      "git.listChangedFiles",
      {
        hostId: "selected-host",
        runningDir: "/repo",
        ignoreWhitespace: false,
        refreshRelations: true,
      },
    );
    expect(
      queryClient.getQueryData(
        gitQueryKeys.listChangedFilesWithSubmodules(
          "selected-host",
          "/repo",
          false,
        ),
      ),
    ).toEqual(response);
    // Parent projection mirrored into the frozen v1.0 slot.
    expect(
      queryClient.getQueryData(
        gitQueryKeys.listChangedFiles("selected-host", "/repo", false),
      ),
    ).toEqual(response);
  });

  it("a forced refresh wins over a late passive poll on the same slot", async () => {
    const forced = snapshot("fp-forced", 1);
    const stale = snapshot("fp-stale", 1);
    const passive = deferred<typeof stale>();

    clientForHost("h").request.mockImplementation(
      (
        _method: string,
        params: { readonly refreshRelations: boolean },
      ) =>
        params.refreshRelations
          ? Promise.resolve(forced)
          : passive.promise,
    );

    const { result } = renderHook(
      () => {
        const snap = useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: null,
        });
        const refresh = useGitRefreshSubmoduleStatus("h");
        return { snap, refresh };
      },
      { wrapper },
    );

    // Passive poll is in flight (refreshRelations:false), still pending.
    await waitFor(() =>
      expect(clientForHost("h").request).toHaveBeenCalledWith(
        "git.listChangedFiles",
        expect.objectContaining({ refreshRelations: false }),
      ),
    );

    // Force a refresh; it resolves and writes the forced snapshot.
    await act(async () => {
      await result.current.refresh.mutateAsync({
        hostId: "h",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
    });

    // The now-superseded passive poll resolves late with stale data.
    await act(async () => {
      passive.resolve(stale);
      await Promise.resolve();
    });

    const cached = queryClient.getQueryData(
      gitQueryKeys.listChangedFilesWithSubmodules("h", "/repo", false),
    );
    expect(cached).toEqual(forced);
  });
});
