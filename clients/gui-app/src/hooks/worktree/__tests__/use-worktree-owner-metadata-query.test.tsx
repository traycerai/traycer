import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  LEGACY_HOST_RESOLVED_AT,
  type WorktreeBinding,
  type WorktreeHostEntryV16,
  type WorktreeWorkspaceSummaryV15,
} from "@traycer/protocol/host/worktree-schemas";
import { perPathEnrichmentQueryKey } from "@/components/settings/panels/worktrees-enrichment-batcher";
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
    // The one host listing first; the listing does not name this binding's
    // worktree, so it is then read by selection.
    expect(fixture.calls("worktree.listAllForHost")).toEqual([
      {
        includeActivity: false,
        activityPaths: null,
        cursor: null,
        limit: null,
        forceRefresh: false,
      },
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
    // the card would read "Workspace snapshot · 56y" on facts fetched a
    // second ago. It
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

  it("forces a refresh across TWO managed worktrees with one wire call, landing each row in its own per-path cache entry", async () => {
    const pathA = "/worktrees/app/feature-a";
    const pathB = "/worktrees/app/feature-b";
    const twoWorktreeBinding: WorktreeBinding = {
      entries: [
        {
          workspacePath: "/repos/app-a",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "app" },
          worktreePath: pathA,
          branch: "feature/a",
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
          workspacePath: "/repos/app-b",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "app" },
          worktreePath: pathB,
          branch: "feature/b",
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
    const calls: Array<
      RequestOfMethod<HostRpcRegistry, "worktree.listAllForHost">
    > = [];
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-two-worktrees",
      handlers: {
        "worktree.getBinding": () =>
          Promise.resolve({
            binding: twoWorktreeBinding,
            missingWorktreePaths: [],
          }),
        "worktree.listAllForHost": (params) => {
          calls.push(params);
          const requested = params.activityPaths ?? [];
          return Promise.resolve({
            worktrees: requested.map((path) =>
              worktreeEntry({
                worktreePath: path,
                branch:
                  path === pathA ? "feature/a-renamed" : "feature/b-renamed",
                resolvedAt: 9_000,
              }),
            ),
            nextCursor: null,
          });
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const rendered = renderHook(
      () =>
        useWorktreeOwnerMetadata({
          client,
          epicId: EPIC_ID,
          ownerId: OWNER_ID,
          ownerKind: "chat",
          binding: undefined,
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.binding).not.toBeNull();
    });

    await act(async () => {
      await rendered.result.current.refresh();
    });

    // ONE wire call covering both managed worktrees, not two.
    const refreshCalls = calls.filter((call) => call.forceRefresh);
    expect(refreshCalls).toHaveLength(1);
    expect([...(refreshCalls[0]?.activityPaths ?? [])].sort()).toEqual(
      [pathA, pathB].sort(),
    );

    // Each row lands in its OWN per-path cache entry - never a shared
    // multi-path key that no observer reads.
    const hostId = client.getActiveHostId();
    const entryA = queryClient.getQueryData<{
      readonly worktrees: readonly WorktreeHostEntryV16[];
    }>(perPathEnrichmentQueryKey(hostId, pathA));
    const entryB = queryClient.getQueryData<{
      readonly worktrees: readonly WorktreeHostEntryV16[];
    }>(perPathEnrichmentQueryKey(hostId, pathB));
    expect(entryA?.worktrees).toHaveLength(1);
    expect(entryA?.worktrees[0]?.worktreePath).toBe(pathA);
    expect(entryB?.worktrees).toHaveLength(1);
    expect(entryB?.worktrees[0]?.worktreePath).toBe(pathB);

    await waitFor(() => {
      expect(rendered.result.current.worktrees).toHaveLength(2);
    });
    const branches = rendered.result.current.worktrees
      .map((entry) => entry.branch)
      .sort();
    expect(branches).toEqual(["feature/a-renamed", "feature/b-renamed"]);
  });

  it("(R2) a background read resolves a trailing-slash binding path with the host's un-slashed row", async () => {
    const fixture = createSlashedBindingFixture();

    const rendered = renderHook(() => useSlashedOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.worktrees).toHaveLength(1);
    });
    expect(rendered.result.current.worktrees[0]?.worktreePath).toBe(
      HOST_SPELLED_WORKTREE_PATH,
    );
  });

  it("(R2) a forced refresh writes the host's un-slashed row into the per-path key for the trailing-slash binding path", async () => {
    const fixture = createSlashedBindingFixture();

    const rendered = renderHook(() => useSlashedOwnerMetadata(fixture.client), {
      wrapper: fixture.Wrapper,
    });

    await waitFor(() => {
      expect(rendered.result.current.binding).not.toBeNull();
    });

    await act(async () => {
      await rendered.result.current.refresh();
    });

    const cached = fixture.queryClient.getQueryData<{
      readonly worktrees: readonly WorktreeHostEntryV16[];
    }>(
      perPathEnrichmentQueryKey(
        fixture.client.getActiveHostId(),
        SLASHED_WORKTREE_PATH,
      ),
    );
    expect(cached?.worktrees).toHaveLength(1);
    expect(cached?.worktrees[0]?.worktreePath).toBe(HOST_SPELLED_WORKTREE_PATH);
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

// R2: an explicit `worktree.import` persists the binding path exactly as the
// caller sent it, while the host answers (and frames) under `path.resolve` of
// it - so a CLI-typed trailing slash comes back without one.
const SLASHED_WORKTREE_PATH = "/worktrees/app/feature-slash/";
const HOST_SPELLED_WORKTREE_PATH = "/worktrees/app/feature-slash";

// Reads the binding over the wire (`binding: undefined`), as a surface that is
// not handed one does, so the slashed path is the one the host stored.
function useSlashedOwnerMetadata(client: HostClient<HostRpcRegistry>) {
  return useWorktreeOwnerMetadata({
    client,
    epicId: EPIC_ID,
    ownerId: OWNER_ID,
    ownerKind: "chat",
    binding: undefined,
    enabled: true,
  });
}

function createSlashedBindingFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const binding: WorktreeBinding = {
    entries: [
      {
        workspacePath: "/repos/app-slash",
        mode: "worktree",
        repoIdentifier: { owner: "acme", repo: "app" },
        worktreePath: SLASHED_WORKTREE_PATH,
        branch: "feature/slash",
        isPrimary: true,
        isImported: true,
        setupState: "succeeded",
        setupTerminalSessionId: null,
        setupExitCode: 0,
        setupFailedAt: null,
        createdAt: 1,
        ownedSubmodules: [],
      },
    ],
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-owner-metadata-slash",
    handlers: {
      "worktree.getBinding": () =>
        Promise.resolve({ binding, missingWorktreePaths: [] }),
      "worktree.listAllForHost": (params) =>
        Promise.resolve({
          worktrees: (params.activityPaths ?? []).map(() =>
            worktreeEntry({
              worktreePath: HOST_SPELLED_WORKTREE_PATH,
              branch: "feature/slash",
              resolvedAt: 1_000,
            }),
          ),
          nextCursor: null,
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    Wrapper,
  };
}

function worktreeEntry(args: {
  readonly worktreePath: string;
  readonly branch: string;
  readonly resolvedAt: number | null;
}): WorktreeHostEntryV16 {
  return {
    worktreePath: args.worktreePath,
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
    presence: "present",
    gitUnreadable: false,
  };
}

function workspaceSummary(args: {
  readonly workspacePath: string;
  readonly branch: string;
  readonly resolvedAt: number | null;
}): WorktreeWorkspaceSummaryV15 {
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
    presence: "present",
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
              worktreePath: WORKTREE_PATH,
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
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
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
