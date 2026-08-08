import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  LEGACY_HOST_RESOLVED_AT,
  type WorktreeBinding,
  type WorktreeHostEntryV14,
  type WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useWorktreeOwnerMetadata } from "@/hooks/worktree/use-worktree-owner-metadata-query";

const EPIC_ID = "epic-1";
const OWNER_ID = "chat-1";
const WORKTREE_PATH = "/worktrees/app/feature-login";
const PLAIN_FOLDER = "/repos/infra";

/**
 * One owner running in two directories at once: a MANAGED WORKTREE and a plain
 * folder it runs in directly. The two need different host reads, which is the
 * whole point of the fixture - `worktree.listAllForHost` walks managed
 * worktrees and never sees `/repos/infra`.
 */
const BINDING: WorktreeBinding = {
  entries: [
    {
      workspacePath: "/repos/app",
      mode: "worktree",
      repoIdentifier: { owner: "acme", repo: "app" },
      worktreePath: WORKTREE_PATH,
      branch: "feature/login",
      isPrimary: true,
      isImported: false,
      setupState: "succeeded",
      setupTerminalSessionId: null,
      setupExitCode: 0,
      setupFailedAt: null,
      createdAt: 1,
      ownedSubmodules: [],
    },
    {
      workspacePath: PLAIN_FOLDER,
      mode: "local",
      repoIdentifier: { owner: "acme", repo: "infra" },
      worktreePath: null,
      // Null on purpose: this field records the branch a WORKTREE binding was
      // created on. A plain folder has none, which is why the branch has to
      // come from the workspace summary.
      branch: null,
      isPrimary: false,
      isImported: false,
      setupState: "succeeded",
      setupTerminalSessionId: null,
      setupExitCode: 0,
      setupFailedAt: null,
      createdAt: 1,
      ownedSubmodules: [],
    },
  ],
};

describe("useWorktreeOwnerMetadata", () => {
  afterEach(() => {
    cleanup();
  });

  it("reads a plain folder through listByWorkspacePaths, which the worktree walk never covers", async () => {
    const fixture = createFixture(null);
    const rendered = renderHook(() => useOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.workspaces).toHaveLength(1);
    });

    // Split correctly: the managed worktree goes to the host-wide walk, the
    // plain folder to the per-workspace summary. Sending the plain folder to
    // the walk would return nothing for it, and it is that silent nothing -
    // falling through to the entry's null `branch` - that rendered "No branch".
    expect(fixture.calls("worktree.listAllForHost")).toEqual([
      {
        includeActivity: true,
        activityPaths: [WORKTREE_PATH],
        cursor: null,
        limit: null,
        forceRefresh: false,
      },
    ]);
    expect(fixture.calls("worktree.listByWorkspacePaths")).toEqual([
      { workspacePaths: [PLAIN_FOLDER], scriptRefs: [], forceRefresh: false },
    ]);
    expect(rendered.result.current.workspaces[0].worktrees[0].branch).toBe(
      "main",
    );
  });

  it("takes the oldest resolvedAt across both reads, since the card is only as fresh as its stalest folder", async () => {
    const fixture = createFixture({
      worktreeResolvedAt: 5_000,
      workspaceResolvedAt: 2_000,
    });
    const rendered = renderHook(() => useOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.checkedAt).toBe(2_000);
    });
  });

  it("ignores LEGACY_HOST_RESOLVED_AT rather than rendering it as an age", async () => {
    // A host predating `resolvedAt` gets its rows bridged to the literal `1`.
    // That is a resolved-MARKER, not a time: taken as one it is 1 Jan 1970, so
    // the card would read "Checked 56y ago" on facts fetched a second ago. It
    // is also the smallest possible value, so a plain `Math.min` would let one
    // legacy folder swallow every real timestamp beside it.
    const fixture = createFixture({
      worktreeResolvedAt: LEGACY_HOST_RESOLVED_AT,
      workspaceResolvedAt: 9_000,
    });
    const rendered = renderHook(() => useOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.checkedAt).toBe(9_000);
    });
  });

  it("reports no check time at all when every row is legacy or underived", async () => {
    const fixture = createFixture({
      worktreeResolvedAt: LEGACY_HOST_RESOLVED_AT,
      workspaceResolvedAt: null,
    });
    const rendered = renderHook(() => useOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.workspaces).toHaveLength(1);
    });
    // `null`, not `1` and not `0`: the footer renders nothing rather than
    // claiming a freshness it cannot know.
    expect(rendered.result.current.checkedAt).toBeNull();
  });

  it("forces both reads on refresh and lands them in the cache entries the card already renders from", async () => {
    const fixture = createFixture({
      worktreeResolvedAt: 1_000,
      workspaceResolvedAt: 1_000,
    });
    const rendered = renderHook(() => useOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.checkedAt).toBe(1_000);
    });
    const keysBefore = fixture.hostQueryKeys();

    fixture.setNext({
      branch: "feature/login-renamed",
      workspaceBranch: "release",
      resolvedAt: 7_000,
    });
    await act(async () => {
      await rendered.result.current.refresh();
    });

    // Both legs forced. Refreshing only the worktree walk was the earlier bug:
    // the plain folder silently kept whatever the host had cached, so Refresh
    // looked like it had run and changed nothing.
    expect(fixture.calls("worktree.listAllForHost").at(-1)).toMatchObject({
      activityPaths: [WORKTREE_PATH],
      forceRefresh: true,
    });
    expect(fixture.calls("worktree.listByWorkspacePaths").at(-1)).toEqual({
      workspacePaths: [PLAIN_FOLDER],
      scriptRefs: [],
      forceRefresh: true,
    });

    // The forced responses reach the SCREEN. `forceRefresh` is part of the
    // request params and therefore part of the query key, so reissuing the
    // queries with it flipped would write a second cache entry that no observer
    // reads - the host would re-derive and the card would never move. Asserting
    // the key set is unchanged is what catches that: same keys, new data.
    await waitFor(() => {
      expect(rendered.result.current.worktrees[0].branch).toBe(
        "feature/login-renamed",
      );
    });
    expect(fixture.hostQueryKeys()).toEqual(keysBefore);
    expect(rendered.result.current.workspaces[0].worktrees[0].branch).toBe(
      "release",
    );
    expect(rendered.result.current.checkedAt).toBe(7_000);
  });

  it("re-resolves the binding on refresh when it owns the binding query", async () => {
    // The binding decides WHICH folders the card lists; the listings only
    // describe them. A refresh that skipped it would keep showing a folder the
    // owner had stopped running in.
    const fixture = createFixture(null);
    const rendered = renderHook(
      () =>
        useWorktreeOwnerMetadata({
          client: fixture.client,
          epicId: EPIC_ID,
          ownerId: OWNER_ID,
          ownerKind: "chat",
          binding: undefined,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.binding).not.toBeNull();
    });
    expect(fixture.calls("worktree.getBinding")).toHaveLength(1);

    await act(async () => {
      await rendered.result.current.refresh();
    });
    expect(fixture.calls("worktree.getBinding")).toHaveLength(2);
  });

  it("issues neither read while the card is closed", () => {
    const fixture = createFixture(null);
    renderHook(
      () =>
        useWorktreeOwnerMetadata({
          client: fixture.client,
          epicId: EPIC_ID,
          ownerId: OWNER_ID,
          ownerKind: "chat",
          binding: BINDING,
          enabled: false,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(fixture.calls("worktree.listAllForHost")).toEqual([]);
    expect(fixture.calls("worktree.listByWorkspacePaths")).toEqual([]);
  });
});

function useOwnerMetadata(client: HostClient<HostRpcRegistry>) {
  return useWorktreeOwnerMetadata({
    client,
    epicId: EPIC_ID,
    ownerId: OWNER_ID,
    ownerKind: "chat",
    // Supplied, as the chat status line supplies it, so these tests exercise
    // the two listings rather than the binding RPC.
    binding: BINDING,
    enabled: true,
  });
}

function worktreeEntry(args: {
  readonly branch: string;
  readonly resolvedAt: number | null;
}): WorktreeHostEntryV14 {
  return {
    worktreePath: WORKTREE_PATH,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch: args.branch,
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [],
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: args.resolvedAt,
  };
}

function workspaceSummary(args: {
  readonly workspacePath: string;
  readonly branch: string;
  readonly resolvedAt: number | null;
}): WorktreeWorkspaceSummaryV14 {
  return {
    workspacePath: args.workspacePath,
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "infra" },
    mainBranch: "main",
    // The folder's own checked-out branch lives HERE, on the disk row - the
    // summary itself has no `branch` field.
    worktrees: [
      {
        worktreePath: args.workspacePath,
        branch: args.branch,
        head: null,
        isMain: true,
        isLocked: false,
      },
    ],
    scripts: null,
    repoBranchPrefix: { status: "absent" },
    resolvedAt: args.resolvedAt,
  };
}

function createFixture(
  seed: {
    readonly worktreeResolvedAt: number | null;
    readonly workspaceResolvedAt: number | null;
  } | null,
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly calls: (method: string) => ReadonlyArray<unknown>;
  readonly hostQueryKeys: () => ReadonlyArray<string>;
  readonly setNext: (next: {
    readonly branch: string;
    readonly workspaceBranch: string;
    readonly resolvedAt: number;
  }) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const calls: Array<{ readonly method: string; readonly params: unknown }> =
    [];
  let worktreeBranch = "feature/login";
  let workspaceBranch = "main";
  // `seed === null` rather than `??`: an explicit `null` resolvedAt is a case
  // under test (the host has not derived that row), and `??` would swallow it.
  let worktreeResolvedAt = seed === null ? 1_000 : seed.worktreeResolvedAt;
  let workspaceResolvedAt = seed === null ? 1_000 : seed.workspaceResolvedAt;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-owner-metadata",
    handlers: {
      "worktree.getBinding": (params) => {
        calls.push({ method: "worktree.getBinding", params });
        return Promise.resolve({
          binding: BINDING,
          missingWorktreePaths: [],
        });
      },
      "worktree.listAllForHost": (params) => {
        calls.push({ method: "worktree.listAllForHost", params });
        return Promise.resolve({
          worktrees: [
            worktreeEntry({
              branch: worktreeBranch,
              resolvedAt: worktreeResolvedAt,
            }),
          ],
          nextCursor: null,
        });
      },
      "worktree.listByWorkspacePaths": (params) => {
        calls.push({ method: "worktree.listByWorkspacePaths", params });
        return Promise.resolve({
          workspaces: params.workspacePaths.map((workspacePath) =>
            workspaceSummary({
              workspacePath,
              branch: workspaceBranch,
              resolvedAt: workspaceResolvedAt,
            }),
          ),
          scriptsAtRefs: [],
        });
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
    calls: (method) =>
      calls.filter((call) => call.method === method).map((call) => call.params),
    hostQueryKeys: () =>
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.queryKey))
        .sort(),
    setNext: (next) => {
      worktreeBranch = next.branch;
      workspaceBranch = next.workspaceBranch;
      worktreeResolvedAt = next.resolvedAt;
      workspaceResolvedAt = next.resolvedAt;
    },
  };
}
