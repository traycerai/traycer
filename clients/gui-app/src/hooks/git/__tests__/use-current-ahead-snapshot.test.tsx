import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import React from "react";
import { useCurrentAheadSnapshot } from "../use-current-ahead-snapshot";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

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

function snapshot(fingerprint: string) {
  return {
    runningDir: "/repo",
    headSha: "abc123",
    branch: "development",
    files: [],
    fingerprint,
    repoMode: "normal" as const,
    repoState: { kind: "clean" as const },
    submodules: [],
  };
}

describe("useCurrentAheadSnapshot", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    requestByHost.clear();
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  it("does not fetch until the parent fingerprint (changeToken) is known", () => {
    renderHook(
      () =>
        useCurrentAheadSnapshot({
          hostId: "h",
          parentRunningDir: "/repo",
          ignoreWhitespace: false,
          changeToken: null,
          enabled: true,
        }),
      { wrapper },
    );
    // A null epoch means we cannot fetch at a known epoch → disabled, no RPC.
    expect(clientForHost("h").request).not.toHaveBeenCalled();
  });

  it("keys by the parent epoch, so a previous-epoch cached snapshot is never served", async () => {
    // A prior epoch's snapshot sits in its own key. It must NOT be surfaced for a
    // newer epoch - the whole stale-pin guarantee.
    queryClient.setQueryData(
      gitQueryKeys.submoduleSnapshotAtEpoch("h", "/repo", false, "e1"),
      snapshot("e1"),
    );
    clientForHost("h").request.mockResolvedValue(snapshot("e2"));

    const { result } = renderHook(
      () =>
        useCurrentAheadSnapshot({
          hostId: "h",
          parentRunningDir: "/repo",
          ignoreWhitespace: false,
          changeToken: "e2",
          enabled: true,
        }),
      { wrapper },
    );

    // The e1 cache entry is under a different key, so this observer starts empty
    // and issues a fresh fetch for e2.
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.fingerprint).toBe("e2");
    expect(clientForHost("h").request).toHaveBeenCalledTimes(1);
  });

  it("refetches when the parent epoch advances", async () => {
    clientForHost("h").request.mockImplementation((_method, _params) =>
      Promise.resolve(snapshot("e1")),
    );

    const { result, rerender } = renderHook(
      (props: { changeToken: string }) =>
        useCurrentAheadSnapshot({
          hostId: "h",
          parentRunningDir: "/repo",
          ignoreWhitespace: false,
          changeToken: props.changeToken,
          enabled: true,
        }),
      { wrapper, initialProps: { changeToken: "e1" } },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(clientForHost("h").request).toHaveBeenCalledTimes(1);

    clientForHost("h").request.mockResolvedValue(snapshot("e2"));
    rerender({ changeToken: "e2" });

    // New epoch → new key → a fresh fetch.
    await waitFor(() =>
      expect(clientForHost("h").request).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(result.current.data?.fingerprint).toBe("e2"));
  });

  it("routes the fetch through the selected worktree host", async () => {
    clientForHost("selected").request.mockResolvedValue(snapshot("e1"));

    const { result } = renderHook(
      () =>
        useCurrentAheadSnapshot({
          hostId: "selected",
          parentRunningDir: "/repo",
          ignoreWhitespace: false,
          changeToken: "e1",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(clientForHost("selected").request).toHaveBeenCalledWith(
      "git.listChangedFiles",
      {
        hostId: "selected",
        runningDir: "/repo",
        ignoreWhitespace: false,
        refreshRelations: false,
      },
    );
    expect(requestByHost.get("default")).toBeUndefined();
  });
});
