import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeWorkspaceSummaryV13 } from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useWorktreeListByWorkspacePathsForClient } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";

describe("useWorktreeListByWorkspacePathsForClient", () => {
  afterEach(() => {
    cleanup();
  });

  // The folder picker keys this query on the path set, so adding/removing a
  // folder lands on a fresh cache entry. Without `keepPreviousData` the new key
  // reports `isLoading`, which the picker projects onto every row as "Loading
  // folder metadata…" — the whole list flashes on each edit. This locks in the
  // retain-previous-while-refetching behavior that keeps the surviving rows.
  it("retains the prior result while a changed path set refetches", async () => {
    const fixture = createFixture();
    const rendered = renderHook(
      ({ paths }: { readonly paths: ReadonlyArray<string> }) =>
        useWorktreeListByWorkspacePathsForClient(fixture.client, {
          workspacePaths: paths,
          enabled: true,
        }),
      {
        wrapper: fixture.Wrapper,
        initialProps: { paths: ["/repo/a", "/repo/b"] },
      },
    );

    await waitFor(() => {
      expect(workspacePathsOf(rendered.result.current.data)).toEqual([
        "/repo/a",
        "/repo/b",
      ]);
    });

    // Hold the next request in-flight, then drop a folder from the set.
    let release: () => void = () => undefined;
    fixture.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    rendered.rerender({ paths: ["/repo/a"] });

    await waitFor(() => {
      expect(rendered.result.current.isFetching).toBe(true);
    });
    // The remaining row keeps its resolved metadata; no fresh-load flash.
    expect(rendered.result.current.isLoading).toBe(false);
    expect(rendered.result.current.isPlaceholderData).toBe(true);
    expect(workspacePathsOf(rendered.result.current.data)).toEqual([
      "/repo/a",
      "/repo/b",
    ]);

    // Once the refetch lands, the list updates in place to the new set.
    release();
    await waitFor(() => {
      expect(workspacePathsOf(rendered.result.current.data)).toEqual([
        "/repo/a",
      ]);
    });
    expect(rendered.result.current.isPlaceholderData).toBe(false);
  });
});

function workspacePathsOf(
  data:
    | { readonly workspaces: ReadonlyArray<WorktreeWorkspaceSummaryV13> }
    | undefined,
): ReadonlyArray<string> {
  return (data?.workspaces ?? []).map((workspace) => workspace.workspacePath);
}

function workspaceSummary(workspacePath: string): WorktreeWorkspaceSummaryV13 {
  return {
    workspacePath,
    isGitRepo: false,
    repoIdentifier: null,
    mainBranch: null,
    worktrees: [],
    scripts: null,
    resolvedAt: 1,
  };
}

function createFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly setGate: (gate: Promise<void> | null) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let gate: Promise<void> | null = null;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-worktree-list",
    handlers: {
      "worktree.listByWorkspacePaths": async (params) => {
        if (gate !== null) await gate;
        return {
          workspaces: params.workspacePaths.map(workspaceSummary),
          scriptsAtRefs: params.scriptRefs.map(({ workspacePath, ref }) => ({
            workspacePath,
            ref,
            scripts: null,
          })),
        };
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client,
    Wrapper,
    setGate: (next) => {
      gate = next;
    },
  };
}
