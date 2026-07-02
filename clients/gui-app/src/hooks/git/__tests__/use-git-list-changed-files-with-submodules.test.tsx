import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import {
  useGitListChangedFilesWithSubmodules,
  hasDirtySubmodules,
} from "../use-git-list-changed-files-with-submodules";
import { __resetSubmoduleSnapshotEpochsForTesting } from "@/lib/git/submodule-snapshot-refresh-coordinator";

type SnapshotRequest = (
  method: string,
  params: { readonly refreshRelations: boolean },
) => Promise<unknown>;

// A distinct request spy per host so we can prove the RPC is routed through the
// client bound to the SELECTED worktree host, not the app-wide active host.
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

function snapshot(fingerprint: string) {
  return {
    runningDir: "/repo",
    headSha: "abc123",
    branch: "main",
    files: [],
    fingerprint,
    repoMode: "normal" as const,
    repoState: { kind: "clean" as const },
    submodules: [],
  };
}

describe("useGitListChangedFilesWithSubmodules", () => {
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

  it("routes the fetch through the selected worktree host, not the default host", async () => {
    clientForHost("selected-host").request.mockResolvedValue(snapshot("fp-1"));

    const { result } = renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "selected-host",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: "fp-1",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(clientForHost("selected-host").request).toHaveBeenCalledWith(
      "git.listChangedFiles",
      {
        hostId: "selected-host",
        runningDir: "/repo",
        ignoreWhitespace: false,
        refreshRelations: false,
      },
    );
    // The default/other host's client is never used.
    expect(requestByHost.get("default-host")).toBeUndefined();
  });

  it("refetches when the parent change token changes", async () => {
    clientForHost("h").request.mockResolvedValue(snapshot("fp-1"));

    const { result, rerender } = renderHook(
      (props: { changeToken: string }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: props.changeToken,
        }),
      { wrapper, initialProps: { changeToken: "fp-1" } },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(clientForHost("h").request).toHaveBeenCalledTimes(1);

    rerender({ changeToken: "fp-2" });

    await waitFor(() =>
      expect(clientForHost("h").request).toHaveBeenCalledTimes(2),
    );
  });

  it("does not refetch on an identity change carrying a stale token", async () => {
    clientForHost("h1").request.mockResolvedValue(snapshot("shared-fp"));
    clientForHost("h2").request.mockResolvedValue(snapshot("shared-fp"));

    const { rerender } = renderHook(
      (props: { hostId: string }) =>
        useGitListChangedFilesWithSubmodules({
          hostId: props.hostId,
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
          changeToken: "shared-fp",
        }),
      { wrapper, initialProps: { hostId: "h1" } },
    );

    await waitFor(() =>
      expect(clientForHost("h1").request).toHaveBeenCalledTimes(1),
    );

    // Same token value, different source host → the new key mounts its own
    // fetch, and the carried token must NOT force an extra refetch.
    rerender({ hostId: "h2" });
    await waitFor(() =>
      expect(clientForHost("h2").request).toHaveBeenCalledTimes(1),
    );
    expect(clientForHost("h1").request).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when disabled", () => {
    renderHook(
      () =>
        useGitListChangedFilesWithSubmodules({
          hostId: "h",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: false,
          changeToken: null,
        }),
      { wrapper },
    );
    expect(clientForHost("h").request).not.toHaveBeenCalled();
  });
});

describe("hasDirtySubmodules", () => {
  it("is false for undefined or empty submodules and true otherwise", () => {
    expect(hasDirtySubmodules(undefined)).toBe(false);
    expect(hasDirtySubmodules(snapshot("fp-1"))).toBe(false);
    expect(
      hasDirtySubmodules({
        ...snapshot("fp-1"),
        submodules: [
          {
            repoRoot: "/repo/sub",
            parentPath: "sub",
            branch: null,
            repoState: { kind: "clean" },
            relation: {
              state: "equal",
              recordedPinSha: "1",
              submoduleHeadSha: "1",
            },
            files: [],
          },
        ],
      }),
    ).toBe(true);
  });
});
